"""Testovi postavki kanala u Meili syncu (lanac „postavke kanala”, S8).

Bez mreže i bez živih servisa:
  python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))

import channel_settings as cs  # noqa: E402

UC_A = "UCaaaaaaaaaaaaaaaaaaaaaa"
UC_B = "UCbbbbbbbbbbbbbbbbbbbbbb"
UC_C = "UCcccccccccccccccccccccc"


def load_segments_module():
    os.environ.setdefault("MEILI_KEY", "test")
    spec = importlib.util.spec_from_file_location("meili_segments_index", SCRIPTS / "meili-segments-index.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SEG = load_segments_module()
QUIET = lambda _msg: None  # noqa: E731


class CloseOffTest(unittest.TestCase):
    def test_master_i_tombstone(self):
        self.assertEqual(cs.close_off(["channel_enabled"], "active"), set(cs.KEYS))
        self.assertEqual(cs.close_off([], "withdrawn"), set(cs.KEYS))
        self.assertEqual(cs.close_off([], "deleted"), set(cs.KEYS))
        self.assertEqual(len(cs.KEYS), 20)

    def test_transkript_i_clanak(self):
        t = cs.close_off(["transcript_subtitles"], "active")
        self.assertTrue(set(cs.AI_KEYS) <= t)
        self.assertNotIn("in_app_search", t)
        a = cs.close_off(["article_summary"], "active")
        self.assertTrue(set(cs.ARTICLE_DEPENDENTS) <= a)
        self.assertNotIn("transcript_subtitles", a)

    def test_nepoznat_kljuc_je_ukljucen(self):
        self.assertEqual(cs.close_off(["izmisljeni"], "active"), set())


class SlugTest(unittest.TestCase):
    def test_normalizacija(self):
        self.assertEqual(cs.normalize_slug("domovina_tv"), "domovina-tv")
        self.assertTrue(cs.is_blocked("domovina_tv", {"domovina-tv"}))
        self.assertTrue(cs.is_blocked("Domovina-TV", {"domovina-tv"}))
        self.assertFalse(cs.is_blocked("domovina_tv_2", {"domovina-tv"}))
        self.assertFalse(cs.is_blocked("", {"domovina-tv"}))

    def test_blocked_channels_po_kljucu_i_bez_slugova(self):
        settings = cs.parse_catalog_response({"settings": {
            UC_A: {"status": "active", "off": ["in_app_search"], "slugs": ["domovina-tv"]},
            UC_B: {"status": "active", "off": ["transcript_subtitles"], "slugs": ["kanal_b"]},
            UC_C: {"status": "withdrawn", "off": []},  # bez slugs
        }})
        logs: list[str] = []
        self.assertEqual(cs.blocked_channels(settings, ["in_app_search"], logs.append), {"domovina-tv"})
        self.assertEqual(len([m for m in logs if UC_C in m]), 1)
        self.assertEqual(cs.blocked_channels(settings, SEG.SEGMENTS_KEYS, QUIET), {"domovina-tv", "kanal-b"})
        self.assertEqual(cs.blocked_channels(None, ["in_app_search"], QUIET), set())


class LoadSettingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.snap = Path(self.tmp.name) / "snap.json"

    def tearDown(self):
        self.tmp.cleanup()

    def _ok(self, _url):
        return {UC_A: {"status": "active", "off": ["in_app_search"], "slugs": ["domovina-tv"]}}

    @staticmethod
    def _fail(_url):
        raise RuntimeError("HTTP 503")

    def test_uspjeh_sprema_snimku_pa_pad_koristi_snimku(self):
        s, src = cs.load_settings("http://x", self.snap, fetch=self._ok, log=QUIET)
        self.assertEqual(src, "katalog")
        self.assertTrue(self.snap.exists())
        logs: list[str] = []
        s2, src2 = cs.load_settings("http://x", self.snap, fetch=self._fail, log=logs.append)
        self.assertEqual(src2, "snimka")
        self.assertEqual(s2, s)
        self.assertIn("zadnju uspješnu snimku", logs[0])

    def test_pad_bez_snimke_ne_filtrira(self):
        logs: list[str] = []
        s, src = cs.load_settings("http://x", self.snap, fetch=self._fail, log=logs.append)
        self.assertIsNone(s)
        self.assertEqual(src, "nema")
        self.assertIn("NE filtriram", logs[0])
        self.assertEqual(cs.blocked_channels(s, ["in_app_search"], QUIET), set())

    def test_neispravna_snimka_je_kao_da_je_nema(self):
        self.snap.write_text("{nije json")
        s, src = cs.load_settings("http://x", self.snap, fetch=self._fail, log=QUIET)
        self.assertEqual((s, src), (None, "nema"))

    def test_fetch_settings_odbija_neispravan_odgovor(self):
        class Res:
            status = 200

            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        ok = cs.fetch_settings("http://x", opener=lambda req, timeout: Res(b'{"version":"1","settings":{}}'))
        self.assertEqual(ok, {})
        with self.assertRaises(RuntimeError):
            cs.fetch_settings("http://x", retries=2, sleep=lambda _s: None,
                              opener=lambda req, timeout: Res(b'{"version":"1"}'))


class EpisodesIndexFilterTest(unittest.TestCase):
    DOCS = [
        {"id": "a_0", "youtube_id": "a", "channel": "domovina_tv", "lead": True},
        {"id": "a_1", "youtube_id": "a", "channel": "domovina_tv", "lead": False},
        {"id": "b_0", "youtube_id": "b", "channel": "sabor", "lead": True},
        {"id": "c_0", "youtube_id": "c", "channel": "glas_koncila", "lead": True},
    ]

    def test_prazne_postavke_vracaju_iste_dokumente(self):
        settings = cs.parse_catalog_response({"version": "1", "settings": {}})
        blocked = cs.blocked_channels(settings, ["in_app_search"], QUIET)
        kept, dropped = cs.filter_docs(self.DOCS, blocked)
        self.assertIs(kept, self.DOCS)
        self.assertEqual(json.dumps(kept), json.dumps(self.DOCS))
        self.assertEqual(dropped, 0)

    def test_iskljucen_kanal_izostaje_s_obje_strane_normalizacije(self):
        kept, dropped = cs.filter_docs(self.DOCS, {"domovina-tv"})
        self.assertEqual([d["id"] for d in kept], ["b_0", "c_0"])
        self.assertEqual(dropped, 2)

    def test_zastita_od_praznjenja(self):
        with self.assertRaises(SystemExit):
            cs.filter_docs(self.DOCS, {"domovina-tv", "sabor"}, max_drop_share=0.5)


class SegmentsPlanTest(unittest.TestCase):
    CORPUS = {"a1": "domovina_tv", "a2": "domovina_tv", "b1": "sabor", "c1": "glas_koncila"}
    FILES = {yt: (f"/x/{yt}.segments.jsonl", f"h-{yt}") for yt in ("a1", "a2", "b1", "c1")}

    def test_prazne_postavke_isti_plan_kao_prije(self):
        state = {"a1": "h-a1", "b1": "staro", "gone1": "h"}
        p = SEG.plan(self.CORPUS, self.FILES, state, set())
        self.assertEqual(p["changed"], ["a2", "b1", "c1"])
        self.assertEqual(p["gone"], ["gone1"])
        self.assertEqual(p["hide"], [])
        self.assertEqual(set(p["eligible"]), set(self.CORPUS))

    def test_iskljucen_kanal_se_skriva_i_ne_indeksira(self):
        state = {"a1": "h-a1", "b1": "h-b1", "c1": "h-c1"}
        p = SEG.plan(self.CORPUS, self.FILES, state, {"domovina-tv"})
        self.assertEqual(p["hide"], ["a1"])
        self.assertEqual(p["changed"], [])  # a2 je novi, ali skriven
        self.assertNotIn("a2", p["eligible"])
        self.assertEqual(p["gone"], [])

    def test_ponovno_ukljucen_kanal_se_vraca(self):
        # Nakon skrivanja a1/a2 nisu u stanju; prazne postavke ih vide kao nove.
        state = {"b1": "h-b1", "c1": "h-c1"}
        p = SEG.plan(self.CORPUS, self.FILES, state, set())
        self.assertEqual(p["changed"], ["a1", "a2"])

    def test_zastita_od_skrivanja_vecine_indeksa(self):
        state = {"a1": "h-a1", "a2": "h-a2", "b1": "h-b1"}
        p = SEG.plan(self.CORPUS, self.FILES, state, {"domovina-tv"}, max_hide_share=0.5)
        self.assertEqual(p["hide"], [])
        self.assertIsNotNone(p["hide_blocked"])
        # I dalje se ne indeksiraju nove epizode skrivenog kanala.
        self.assertNotIn("a1", p["eligible"])


if __name__ == "__main__":
    unittest.main()
