# Builds the whole system into one container for Render.
# You don't need Docker on your PC: Render runs this file on its own servers
# every time you push to GitHub.
#
#   1. build the React web app (web/)
#   2. build the ASP.NET Core backend (backend/)
#   3. copy both into a small runtime image; the backend serves the web app

# ---- 1. web app ----------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# The deployed app talks to the real backend, not the in-browser simulator.
ARG VITE_DATA_SOURCE=api
ENV VITE_DATA_SOURCE=$VITE_DATA_SOURCE
RUN npm run build

# ---- 2. backend ----------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src/backend
COPY backend/ ./
RUN dotnet publish src/SmartWater.Api/SmartWater.Api.csproj -c Release -o /app

# ---- 3. runtime ----------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /app ./
COPY --from=web /src/web/dist ./wwwroot
ENV ASPNETCORE_ENVIRONMENT=Production
# Render sets PORT; Program.cs listens on it.
EXPOSE 10000
ENTRYPOINT ["dotnet", "SmartWater.Api.dll"]
