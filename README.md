# 🎯 Quiz App

Eine containerisierte Quiz-Webanwendung mit Token-basiertem Zugang und Admin-Interface.

## Features

- **Quiz-Frontend** – Token-geschütztes Quiz-Interface für Teilnehmer
- **Admin-Interface** – Fragen verwalten, Tokens erstellen, Ergebnisse einsehen
- **Persistente Daten** – SQLite-Datenbank mit Volume-Mount
- **Bereit für Podman/Docker**

---

## Schnellstart mit Podman

### 1. Image bauen

```bash
podman build -t quiz-app .
```

### 2. Container starten

```bash
podman run -d \
  --name quiz \
  -p 3000:3000 \
  -v quiz-data:/data \
  -e ADMIN_SECRET=meinGeheimesPasswort \
  quiz-app
```

### 3. Zugriff

| URL | Beschreibung |
|-----|-------------|
| `http://localhost:3000/quiz` | Quiz für Teilnehmer |
| `http://localhost:3000/admin` | Admin-Interface |

---

## Umgebungsvariablen

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `PORT` | `3000` | HTTP-Port |
| `DB_PATH` | `/data/quiz.db` | Pfad zur SQLite-Datenbank |
| `ADMIN_SECRET` | `admin1234` | Admin-Passwort (unbedingt ändern!) |

---

## Workflow

### Als Admin:

1. Gehe zu `/admin` und melde dich mit dem Admin-Passwort an
2. **Fragen** – Erstelle Fragen mit mehreren Antwortmöglichkeiten
3. **Tokens** – Erstelle Tokens für Teilnehmer (einzeln oder in Massen)
4. Teile die Tokens mit den Teilnehmern
5. **Ergebnisse** – Beobachte die Ergebnisse in Echtzeit

### Als Teilnehmer:

1. Gehe zu `/quiz`
2. Gib deinen Token ein (oder nutze `/quiz?token=DEIN-TOKEN`)
3. Beantworte die Fragen – jede kann nur einmal beantwortet werden
4. Am Ende siehst du dein Ergebnis

---

## Mit Podman Compose (optional)

Erstelle eine `compose.yaml`:

```yaml
services:
  quiz:
    image: quiz-app
    build: .
    ports:
      - "3000:3000"
    volumes:
      - quiz-data:/data
    environment:
      - ADMIN_SECRET=meinGeheimesPasswort
    restart: unless-stopped

volumes:
  quiz-data:
```

Starten mit:
```bash
podman-compose up -d
```

---

## Datensicherung

Die SQLite-Datenbank liegt im Volume `/data/quiz.db`. Für ein Backup:

```bash
podman cp quiz:/data/quiz.db ./backup-quiz.db
```

---

## Technologie

- **Backend**: Node.js + Express + better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (keine Abhängigkeiten)
- **Datenbank**: SQLite
- **Container**: Alpine Linux (Node 20)
