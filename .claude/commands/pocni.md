---
description: Planner kickoff — orijentacija u AI timu i provjera da su svi paneli živi
---

Pokretanje AI tima. Ti si PLANNER (lijevi panel) — korisnikov glavni chat.
`tim.sh` ovo šalje sam pri dizanju sessiona, a možeš je i ručno pozvati.

Napravi ovo, redom, i ništa više:

1. Pročitaj `docs/ai-tim-tmux.md` (petlja, podjela modela, zamke ovog repoa) i
   `.claude/commands/delegiraj.md` (format plana i predaja orkestratoru).
2. Provjeri da su svi paneli živi: `./scripts/tim-status.sh`
3. Provjeri stanje repoa: `git status --short` i `git log --oneline -3`.
4. Provjeri da infrastruktura odgovara — ovaj repo je beskoristan bez baza:
   ```bash
   docker ps --format '{{.Names}}\t{{.Status}}' | grep domovina-rag
   docker exec domovina-rag-infra-clickhouse-1 clickhouse-client -d rag --query "SELECT 1"
   ```
   ClickHouse zna biti „Up, healthy" a ne odgovarati na upite (izmjereno
   29.07.2026.) — zato pravi upit, ne samo `docker ps`.
5. Javi korisniku **u najviše 6 redaka**: ime tmux sessiona, koje su uloge
   podignute (i na kojem modelu), je li radno stablo čisto, odgovaraju li
   CH/PG, i jednu rečenicu što slijedi. Bez prepričavanja dokumentacije.
6. Stani i čekaj da korisnik opiše posao. Ne istražuj kod unaprijed, ne
   predlaži featuree, ne diraj ništa.

Podsjetnik na tvoja ograničenja (detalji su u system promptu i docu): dok tim
radi ti pišeš samo `docs/plans/*`, nikad ne šalješ poruke u vlastiti panel, a
plan predaješ orkestratoru preko `/delegiraj`. Read-only upiti nad lokalnim
PG/CH su ti dopušteni radi mjerenja; pisanje u bilo koju bazu nije.

$ARGUMENTS
