# Smart Water backend (ASP.NET Core, .NET 10)

Phase 0 skeleton. It already:

- serves the built web app (from `wwwroot` on Render, from `../../../web/dist` locally)
- sends React routes such as `/alerts` to `index.html` so deep links work
- answers `GET /api/health` with the database status and the number of active zones and sensors

Phase 3 adds the MQTT ingestion, heartbeat, detection, alert and valve-control services,
the API endpoints the web app expects (listed in `web/README.md`) and the SignalR hub.

## Run locally

```powershell
cd ..\web; npm run build; cd ..\backend\src\SmartWater.Api
dotnet user-secrets set "ConnectionStrings:Default" "<Neon connection string>"
dotnet run        # http://localhost:5000
```

Without a connection string it still runs and `/api/health` reports `"database": "not configured"`.

## Configuration

| Setting | Locally | On Render |
|---|---|---|
| Neon connection string | `dotnet user-secrets set "ConnectionStrings:Default" "..."` | Env var `ConnectionStrings__Default` |
| Port | 5000 (launchSettings.json) | Render's `PORT` |
