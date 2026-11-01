# Database setup tool

Runs the SQL files in `db/` against Neon without needing `psql`. It reads
`DATABASE_URL_UNPOOLED` (the direct connection) from `.env.local` at the repo root, which
`neon deploy` / `neon env pull` write.

```powershell
cd tools\dbsetup
dotnet run                                                   # show what's in the database
dotnet run -- ..\..\db\001_schema.sql ..\..\db\002_seed.sql      # set up an empty database
dotnet run -- ..\..\db\rig\10_zone_b.sql                       # when Zone B is built
dotnet run -- ..\..\db\tools\reset_demo_data.sql                 # before a presentation
```

Each file runs in its own transaction, so a file that fails changes nothing. The
`db/tests` files use psql commands (`\echo`) and don't run here.
