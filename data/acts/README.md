# Bare Act sources for the Knowledge Center

Drop the plain text of each Act here, one file per topic:

```
data/acts/consumer.txt        Consumer Protection Act, 2019
data/acts/cyber.txt           Information Technology Act, 2000
data/acts/traffic.txt         Motor Vehicles Act, 1988
data/acts/posco.txt           Protection of Children from Sexual Offences Act, 2012
data/acts/cheque_ni_act.txt   Negotiable Instruments Act, 1881
```

## Why these are files rather than fetched

Every official source refuses automated access:

| Source | Result |
|---|---|
| `indiacode.nic.in` | 403 |
| `legislative.gov.in` | 403 |
| `en.wikisource.org` | Acts not present |

Asking the model to recall an Act from memory instead is not an option. A
fabricated section number or penalty published under a law firm's name is the
exact failure the grounding contract exists to prevent — so every card must
quote text that is verifiably present in one of these files.

Downloading each Act once is a few minutes of work and makes the whole pipeline
deterministic thereafter.

## Getting the text

1. Open the Act on <https://www.indiacode.nic.in> in a browser
2. Download the PDF
3. Copy the text out (Preview, Acrobat, or `pdftotext`) into the file above

Keep the section numbering intact — `12.` and `12A.` at the start of a line is
what the splitter keys on. Front matter (preamble, table of contents) is
stripped automatically.

## Seeding

Check the split before spending any quota:

```bash
npx tsx scripts/seed-acts.ts "Consumer Protection Act" --category consumer --max-sections 20 --dry-run
```

Then create the cards:

```bash
npx tsx scripts/seed-acts.ts "Consumer Protection Act"                        --category consumer      --max-sections 20
npx tsx scripts/seed-acts.ts "Information Technology Act"                     --category cyber         --max-sections 20
npx tsx scripts/seed-acts.ts "Motor Vehicles Act"                             --category traffic       --max-sections 20
npx tsx scripts/seed-acts.ts "Protection of Children from Sexual Offences Act" --category posco        --max-sections 20
npx tsx scripts/seed-acts.ts "Negotiable Instruments Act"                     --category cheque_ni_act --max-sections 20
```

Cards land as **pending** in `/admin/shorts`. Review them, then select all and
approve. Add `--publish` to skip review once you trust the output — but read the
first batch by hand before you do.

Re-running is safe: sections already seeded are skipped, so an interrupted run
resumes where it stopped.
