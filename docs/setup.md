# Setup guide (Windows)

Four parts, in the order the work needs them. **Secrets** (passwords, connection strings)
only ever go into `dotnet user-secrets` on your PC, Render's environment settings, or
`firmware/node/secrets.h`. Never into a file Git tracks, and never into chat.

> **PowerShell tip:** put secret values in **single quotes** `'like this'`. In double
> quotes PowerShell treats `$` as a variable and silently changes your password.

---

## 1. Neon (PostgreSQL database)

**Done on 1 Nov 2026.** Project `smart-water` (`weathered-smoke-12212274`), region
**aws-eu-central-1 (Frankfurt)**, Postgres 18. The schema and seed are loaded on the
`production` branch.

How it's wired, so you can explain it:

- `neon.ts` (repo root) is the project's Neon config. `neon deploy` applies it and writes
  the connection strings into **`.env.local`**, which Git ignores:
  - `DATABASE_URL`: the **pooled** connection (`-pooler` host). The backend uses it,
    because a web server makes many short queries.
  - `DATABASE_URL_UNPOOLED`: the **direct** connection. `tools/dbsetup` uses it for schema
    changes, as Neon recommends.
- Locally the backend reads `DATABASE_URL` from `.env.local`; on Render it's an
  environment variable. `backend/.../Database/DatabaseUrl.cs` turns Neon's
  `postgresql://` URL into the format Npgsql (the .NET driver) expects.

### Redo it on another PC

```powershell
npx neon@latest login          # opens the browser to sign in
npx neon@latest env pull       # writes .env.local for the linked branch
cd backend\src\SmartWater.Api
dotnet run                     # http://localhost:5000/api/health -> "database":"ok"
```

### Load or reset the database

```powershell
cd tools\dbsetup
dotnet run                                                   # shows what's in it
dotnet run -- ..\..\db_schema.sql ..\..\db_seed.sql      # empty database only
dotnet run -- ..\..\db	oolseset_demo_data.sql                 # before a presentation
```

### A `dev` branch for testing

Test on a branch so test data never reaches the demo database:

```powershell
npx neon@latest checkout dev --create   # copy of production, .env.local now points at it
npx neon@latest checkout production     # back to production before presenting
```

`neon.ts` makes new branches **expire after 7 days** (`ttl: "7d"`). That's fine for
throw-away test branches. For a long-lived `dev`, remove the `ttl` line first.

---

## 2. HiveMQ Cloud (MQTT broker)

About 10 minutes.

### 2.1 Create the cluster
1. Go to **https://console.hivemq.cloud** → sign up and confirm your email.
2. Choose **Serverless** (the free plan) → **Create cluster**.
3. Open the cluster (**Manage cluster**). On **Overview**, find:
   - **Cluster URL**, like `a1b2c3d4e5.s1.eu.hivemq.cloud`. Copy it somewhere: you'll paste it below.
   - **Port** `8883` (TLS). That's the one we use.

### 2.2 Create two logins
One for the backend, one for node-2. The simulator uses node-2's, because it pretends to
be node-2.
1. Open the **Access Management** tab → **Credentials** → **Create credential**
   (on some versions it's **Add credentials**).
2. First login:
   - **Username:** `backend`
   - **Password:** make a strong one (12+ characters, upper and lower case, digits).
     A password manager's generator is ideal.
   - **Permission:** **Publish and Subscribe**
   - → **Create** / **Save**.
3. Second login: **Username** `node-2`, a different strong password, **Publish and Subscribe**.
4. Keep both passwords in your password manager. HiveMQ won't show them again.

### 2.3 Give the passwords to the simulator and the backend
In PowerShell from the repo folder, pasting your values between the single quotes:

```powershell
cd tools\simulator
dotnet user-secrets set 'Mqtt:Host' '<cluster URL, without https://>'
dotnet user-secrets set 'Mqtt:Username' 'node-2'
dotnet user-secrets set 'Mqtt:Password' '<node-2 password>'

cd ..\..\backend\src\SmartWater.Api
dotnet user-secrets set 'Mqtt:Host' '<cluster URL>'
dotnet user-secrets set 'Mqtt:Username' 'backend'
dotnet user-secrets set 'Mqtt:Password' '<backend password>'
```

The firmware gets node-2's details in `firmware/node/secrets.h` (see `firmware/` README).

### 2.4 Test with HiveMQ's web client
1. In the cluster, open the **Web Client** tab.
2. Connect with the **backend** username and password.
3. **Subscriptions** → **Add new topic subscription** → topic `smartwater/#` → **Subscribe**.
4. In PowerShell: `cd tools\simulator` then `dotnet run`. Within a second the web client
   shows `smartwater/node-2/status` (online), then `smartwater/node-2/readings` every
   second.
5. Press **O** in the simulator: `status` with `"state":"offline"` should appear straight
   away. Press **O** again to reconnect, then **Q** to quit.

---

## 3. Local development (all on your PC)

Install once:
| What | Where | Check in PowerShell |
|---|---|---|
| .NET 10 SDK | https://dotnet.microsoft.com/download → .NET 10 → SDK, Windows x64 | `dotnet --version` → `10.…` |
| Node.js LTS | https://nodejs.org → LTS, Windows installer | `node -v` → `v22` or newer |

Run the whole system with three PowerShell windows:

| Window | Folder | Command | What it is |
|---|---|---|---|
| 1 | `backend\src\SmartWater.Api` | `dotnet run` | API + MQTT + detection on http://localhost:5000 |
| 2 | `web` | `npm run dev` | Web app with live reload on http://localhost:5173 (needs `VITE_DATA_SOURCE=api` in `web\.env`) |
| 3 | `tools\simulator` | `dotnet run` | Fake node-2 (or power the real node instead, never both) |

Or skip window 2: `npm run build` in `web` once, and the backend serves the app itself on
http://localhost:5000, just as Render does.

---

## 4. Render (hosting)

Do this after the backend works locally. The walkthrough comes when the work reaches it.

1. Push the repo to GitHub (private).
2. https://render.com → sign up with GitHub → **New +** → **Blueprint** → pick the
   `smart-water` repo. Render reads `render.yaml`: one free web service in Frankfurt.
3. It asks for the secret settings. Paste:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | `DATABASE_URL` from `.env.local` (pooled, production branch), pasted as it is |
   | `Mqtt__Host` | HiveMQ cluster URL |
   | `Mqtt__Username` | `backend` |
   | `Mqtt__Password` | backend password |
4. **Apply**. The first build takes about 5 minutes. Then open
   `https://<service>.onrender.com/api/health`.

The double underscore `__` is how environment variables write the `:` in setting names.
