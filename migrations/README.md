# LegalX Database Migrations

All migrations are plain SQL files named `YYYYMMDDHHMMSS_description.sql`.

## Naming Convention

```
YYYYMMDDHHMMSS_short_description.sql
│              │
│              └── snake_case description of what this migration does
└── UTC timestamp (sortable, collision-free across developers)
```

## Execution Order

Run migrations **in alphabetical / timestamp order**. Each file is idempotent (`IF NOT EXISTS`, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`).

## Running on Supabase

**Option A — Supabase SQL Editor (recommended for production)**
1. Open your project at https://supabase.com/dashboard
2. Navigate to **SQL Editor → New Query**
3. Paste and run each file in timestamp order

**Option B — psql direct**
```bash
# Set your connection string from Supabase Dashboard → Settings → Database → Connection string
export DATABASE_URL="postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"

# Run all migrations in order
for f in migrations/*.sql; do
  echo "Running: $f"
  psql "$DATABASE_URL" -f "$f"
done
```

**Option C — Supabase CLI (recommended for CI/CD)**
```bash
supabase db push          # push local migrations to remote
supabase migration new     # create a new timestamped migration
```

## Migration Files

| File | Description |
|------|-------------|
| `20240101000000_extensions_and_enums.sql` | Extensions (pgcrypto, citext, pg_trgm) + all ENUM types |
| `20240101000001_sales_funnel.sql` | Leads, applications, guest payments |
| `20240101000002_geography.sql` | Countries, states, cities, languages |
| `20240101000003_identity.sql` | Accounts (extends auth.users), OAuth, OTP + RLS |
| `20240101000004_lawyer_profiles.sql` | Lawyer profiles, documents, practice areas + RLS |
| `20240101000005_service_orders.sql` | Service catalog + customer orders |
| `20240101000006_consultations.sql` | Bookings, sessions + RLS |
| `20240101000007_messaging.sql` | Conversations, messages + RLS |
| `20240101000008_payments_and_wallet.sql` | Wallets, orders, transactions, commissions + RLS |
| `20240101000009_reviews_and_content.sql` | Reviews, articles |
| `20240816000001_add_lawyer_profile_fields.sql` | Additive: `verified_at`, `rejection_reason` on lawyer_profiles |

## Adding a New Migration

```bash
# Use the current UTC timestamp
TS=$(date -u +"%Y%m%d%H%M%S")
touch migrations/${TS}_your_description.sql
```

Always make migrations:
- **Forward-only** — never edit an already-run migration
- **Idempotent** — use `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DO $$ BEGIN ... EXCEPTION WHEN ... END $$`
- **Reversible where possible** — add a commented-out `-- ROLLBACK:` section
