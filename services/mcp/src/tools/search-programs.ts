// search_programs MCP tool — semantička pretraga izbornih programa stranaka
// (parlamentarni izbori 2024.) nad `program_chunks`.
//
// Tijek je isti kao search_podcasts:
//  1. embed upita → 1024-d bge-m3 vektor (isti embedder, bez prefiksa)
//  2. CH SELECT ORDER BY cosineDistance(...) LIMIT N (HNSW indeks ubrzava)
//  3. format: stranka, dokument, poglavlje, stranica, citat, URL, sličnost
//
// Postavke kanala ovdje NE vrijede: program nije sadržaj ničijeg kanala.
// Auth i rate limit su na HTTP sloju (index.ts) i pokrivaju sve alate.
//
// Tablica je ReplacingMergeTree; kao i search_podcasts čitamo BEZ `FINAL`
// (FINAL bi zaobišao vektorski indeks). Duplikate prije mergea (isti
// chunk_id) izbacujemo nakon upita.

import type { ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

import type { EmbedderClient } from "../embedder.js";


export const PROGRAMS_LIMIT_DEFAULT = 5;
export const PROGRAMS_LIMIT_MAX = 20;
/** Najdulji citat u odgovoru (znakova) prije rezanja na granici rečenice/riječi. */
export const QUOTE_MAX_CHARS = 700;

export const SearchProgramsInput = z.object({
  query: z.string().min(2).max(500).describe("Tekstualni upit na hrvatskom"),
  // Prazan string (LLM klijenti ga znaju poslati) = bez filtra.
  party: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(100).optional(),
    )
    .describe("Stranka: ID, slug, kratica (HDZ, SDP, Možemo) ili dio naziva"),
  // Clamp umjesto odbijanja: prevelik limit nije greška korisnika koju treba
  // vratiti LLM-u, nego samo strop zbog token budgeta.
  limit: z.coerce
    .number()
    .int()
    .default(PROGRAMS_LIMIT_DEFAULT)
    .transform((n) => Math.min(PROGRAMS_LIMIT_MAX, Math.max(1, n))),
});

export type SearchProgramsArgs = z.infer<typeof SearchProgramsInput>;

export const searchProgramsJsonSchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      minLength: 2,
      maxLength: 500,
      description: "Tema ili pitanje na hrvatskom (npr. 'porez na nekretnine', 'mirovine').",
    },
    party: {
      type: "string",
      maxLength: 100,
      description:
        "Neobavezno: samo programi ove stranke. Prima ID stranke ('258'), slug, " +
        "kraticu ('HDZ', 'SDP', 'Možemo') ili dio službenog naziva (bez obzira na " +
        "velika slova i dijakritike). Koalicijski program pogađa svaka stranka koalicije.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: PROGRAMS_LIMIT_MAX,
      default: PROGRAMS_LIMIT_DEFAULT,
      description: `Maks. broj odlomaka (1-${PROGRAMS_LIMIT_MAX}, default ${PROGRAMS_LIMIT_DEFAULT}).`,
    },
  },
  required: ["query"],
};


export interface ProgramParty {
  id: number;
  name: string;
  short: string;
  slug: string;
}

export interface ProgramHit {
  chunk_id: string;
  doc_id: string;
  parties: ProgramParty[];
  naslov: string;
  section: string;
  page_from: number;
  page_to: number;
  format: string;
  izvor: string;
  nesiguran: boolean;
  nesiguran_razlog: string;
  url: string;
  datum: string;
  quote: string;          // tijelo odlomka (bez naslova poglavlja), skraćeno
  score: number;          // 1 - cosineDistance, viši = bolji
}

interface ProgramRow {
  chunk_id: string;
  doc_id: string;
  party_ids: number[];
  party_names: string[];
  party_short: string[];
  party_slugs: string[];
  naslov: string;
  section: string;
  page_from: number;
  page_to: number;
  format: string;
  izvor: string;
  nesiguran: number;
  nesiguran_razlog: string;
  url: string;
  datum: string;
  text: string;
  distance: number;
}


// Isto preslikavanje kao `foldSql` ispod: lowerUTF8 + čćžšđ → cczsd. Drugi
// dijakritici se ne diraju ni na jednoj strani, pa usporedba ostaje dosljedna.
const FOLD_FROM = "čćžšđ";
const FOLD_TO = "cczsd";

/** Normalizacija upita za stranku: mala slova, bez hrvatskih dijakritika, sažeti razmaci. */
export function foldParty(s: string): string {
  let out = s.toLowerCase().trim().replace(/\s+/g, " ");
  for (let i = 0; i < FOLD_FROM.length; i++) {
    out = out.split(FOLD_FROM[i]!).join(FOLD_TO[i]!);
  }
  return out;
}

const foldSql = (expr: string) => `translateUTF8(lowerUTF8(${expr}), '${FOLD_FROM}', '${FOLD_TO}')`;

/**
 * WHERE uvjet za `party`. Vrijednost korisnika ide isključivo kroz parametre.
 *
 *  - samo znamenke → ID stranke: `has(party_ids, …)`
 *  - inače: kratica ili slug JEDNAKI (kratica se ne uspoređuje kao podniz jer
 *    bi „DP” pogodio „SDP”), ili podniz službenog naziva (od 3 znaka naviše).
 */
export function buildPartyFilter(party: string): { clause: string; params: Record<string, unknown> } {
  const raw = party.trim();
  if (/^\d+$/.test(raw)) {
    return { clause: "has(party_ids, {party_id:UInt32})", params: { party_id: Number(raw) } };
  }
  const q = foldParty(raw);
  const slugQ = q.replace(/ /g, "-");
  const parts = [
    `arrayExists(x -> ${foldSql("x")} = {party_q:String}, party_short)`,
    `arrayExists(x -> x = {party_slug:String}, party_slugs)`,
  ];
  if (q.length >= 3) {
    parts.push(`arrayExists(x -> position(${foldSql("x")}, {party_q:String}) > 0, party_names)`);
  }
  return { clause: `(${parts.join(" OR ")})`, params: { party_q: q, party_slug: slugQ } };
}


/** Tijelo odlomka: `text` je "<section>\n\n<body>", pa uzimamo sve nakon prvog praznog retka. */
export function chunkBody(text: string): string {
  const i = text.search(/\n\s*\n/);
  const body = i >= 0 ? text.slice(i).replace(/^\s+/, "") : text;
  return body.replace(/\s+/g, " ").trim();
}

/** Skraćuje citat na granici rečenice (ako ne gubi više od pola), inače riječi, uz „…”. */
export function trimQuote(s: string, max = QUOTE_MAX_CHARS): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  let cut = -1;
  for (const m of head.matchAll(/[.!?…](?=\s|$)/g)) cut = m.index! + 1;
  if (cut >= max * 0.5) return head.slice(0, cut) + " …";
  const sp = head.lastIndexOf(" ");
  return (sp > 0 ? head.slice(0, sp) : head).replace(/[\s,;:–-]+$/, "") + " …";
}


export async function searchPrograms(
  args: SearchProgramsArgs,
  deps: { ch: ClickHouseClient; embedder: EmbedderClient },
): Promise<ProgramHit[]> {
  const vector = await deps.embedder.embedOne(args.query);

  const params: Record<string, unknown> = { query_vec: vector, limit: args.limit };
  let where = "";
  if (args.party) {
    const f = buildPartyFilter(args.party);
    where = `WHERE ${f.clause}`;
    Object.assign(params, f.params);
  }

  const sql = `
    SELECT
      chunk_id, doc_id,
      party_ids, party_names, party_short, party_slugs,
      naslov, section, page_from, page_to, format, izvor,
      nesiguran, nesiguran_razlog, url, datum, text,
      cosineDistance(embedding, {query_vec:Array(Float32)}) AS distance
    FROM program_chunks
    ${where}
    ORDER BY distance ASC
    LIMIT {limit:UInt32}
  `;

  const resultSet = await deps.ch.query({ query: sql, query_params: params, format: "JSONEachRow" });
  const rows = (await resultSet.json()) as ProgramRow[];

  const seen = new Set<string>();
  const hits: ProgramHit[] = [];
  for (const r of rows) {
    if (seen.has(r.chunk_id)) continue;
    seen.add(r.chunk_id);
    hits.push({
      chunk_id: r.chunk_id,
      doc_id: r.doc_id,
      parties: (r.party_ids ?? []).map((id, i) => ({
        id: Number(id),
        name: r.party_names?.[i] ?? "",
        short: r.party_short?.[i] ?? "",
        slug: r.party_slugs?.[i] ?? "",
      })),
      naslov: r.naslov,
      section: r.section,
      page_from: Number(r.page_from),
      page_to: Number(r.page_to),
      format: r.format,
      izvor: r.izvor,
      nesiguran: Number(r.nesiguran) === 1,
      nesiguran_razlog: r.nesiguran_razlog,
      url: r.url,
      datum: r.datum,
      quote: trimQuote(chunkBody(r.text)),
      score: 1 - Number(r.distance),
    });
  }
  return hits;
}


// ---------------------------------------------------------------- formatiranje

const IZVOR_LABEL: Record<string, string> = {
  wayback: "Wayback snimka",
  web: "web stranica stranke",
};

export function partyLabel(parties: ProgramParty[]): string {
  const names = parties.map((p) => p.short || p.name || `stranka #${p.id}`);
  return names.length > 0 ? names.join(", ") : "nepoznata stranka";
}

export function pageLabel(h: Pick<ProgramHit, "format" | "page_from" | "page_to">): string {
  if (h.format === "html") return "web stranica";
  if (!h.page_from) return "";
  if (h.page_to && h.page_to !== h.page_from) return `str. ${h.page_from}–${h.page_to}`;
  return `str. ${h.page_from}`;
}

export function sourceNote(h: Pick<ProgramHit, "nesiguran" | "izvor" | "nesiguran_razlog">): string {
  if (!h.nesiguran) return "";
  const label = IZVOR_LABEL[h.izvor] ?? (h.izvor || "nepoznat");
  return h.nesiguran_razlog ? `⚠ izvor: ${label} — ${h.nesiguran_razlog}` : `⚠ izvor: ${label} (nesiguran)`;
}

export function formatProgramHits(hits: ProgramHit[], args: SearchProgramsArgs): string {
  if (hits.length === 0) {
    if (args.party) {
      return (
        `Nije pronađen izborni program (parlamentarni izbori 2024.) za stranku „${args.party}”. ` +
        "Provjeri kraticu (npr. HDZ, SDP, Možemo), slug, ID ili dio službenog naziva stranke, " +
        "ili pretraži bez filtra stranke."
      );
    }
    return `Nema odlomaka iz izbornih programa (parlamentarni izbori 2024.) za upit „${args.query}”.`;
  }

  const head =
    `Odlomci iz izbornih programa stranaka (parlamentarni izbori 2024.) za upit „${args.query}”` +
    (args.party ? `, stranka „${args.party}”` : "") +
    `: ${hits.length}. Pri navođenju citiraj odlomak i navedi dokument i stranicu.`;

  const blocks = hits.map((h, i) => {
    const lines = [`${i + 1}. ${partyLabel(h.parties)} — ${h.naslov || "(bez naslova)"}`];
    const meta = [
      h.section ? `poglavlje: ${h.section}` : "",
      pageLabel(h),
      h.datum ? `datum: ${h.datum}` : "",
      `sličnost ${h.score.toFixed(3)}`,
    ].filter(Boolean);
    lines.push(`   ${meta.join(" · ")}`);
    lines.push(`   „${h.quote}”`);
    if (h.url) lines.push(`   URL: ${h.url}`);
    const note = sourceNote(h);
    if (note) lines.push(`   ${note}`);
    lines.push(`   chunk_id: ${h.chunk_id}`);
    return lines.join("\n");
  });

  return [head, ...blocks].join("\n\n");
}
