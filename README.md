# BrieflyAI

**Ask your data anything — across every platform.**

BrieflyAI is an AI-powered productivity assistant that connects the tools you already use and answers natural-language questions about your real, live data. Summarize your inbox, prepare for tomorrow's meetings, review open GitHub issues, or catch up on Discord and Telegram — all from one dashboard.

<!-- Badges -->
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-4-38bdf8?logo=tailwindcss&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169e1?logo=postgresql&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3fcf8e?logo=supabase&logoColor=white)
![Groq](https://img.shields.io/badge/Groq-f55036?logo=groq&logoColor=white)
![OAuth 2.0](https://img.shields.io/badge/OAuth%202.0-eb5424?logo=auth0&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

[Live Demo](https://briefly-ai-tau.vercel.app/)

---

## Features

BrieflyAI routes every request through a **tool planner → executor → Groq summarizer** pipeline. Tools retrieve *real* data from your connected accounts; the AI then explains it in plain language — nothing is fabricated.

### AI Assistant

| Capability | Description |
| --- | --- |
| Natural language interface | Ask questions like you'd ask a person, not a search box |
| Cross-platform queries | One question can pull from any connected integration |
| AI-generated summaries | Groq-powered responses grounded in live tool data |
| Smart search | Gmail-syntax search, Drive file search, Telegram message search |
| Context-aware responses | Actions, insights, and sources rendered as structured cards |

### Gmail

- Inbox summaries
- Email search (including Gmail syntax such as `has:attachment`)
- Unread emails
- Important email ranking
- Thread summaries

### Google Calendar

- Upcoming meetings
- Daily schedule
- Weekly overview
- Meeting preparation briefs

### Google Drive

- Recent files
- Search files
- Document summaries

### GitHub

- Repository summaries
- Open issues summary
- Recent activity (commits, PRs, releases)

### Discord

**Supported:** list your servers · summarize servers

**Limitation:** reading channels/messages requires a Discord Bot — Discord's OAuth API doesn't expose those endpoints, so the assistant explains the requirement instead of returning empty data.

### Telegram

- Recent messages
- Accessible chats (chats the bot has been added to)
- Chat summaries & news digests

---

## Screenshots

<img width="1901" height="937" alt="image" src="https://github.com/user-attachments/assets/7e6a70de-4004-437f-9348-effdd63c5aee" />
<img width="1881" height="934" alt="image" src="https://github.com/user-attachments/assets/57ef178f-5bdd-4973-85db-6897b6d98e03" />
<img width="1898" height="890" alt="image" src="https://github.com/user-attachments/assets/9384eb00-68f6-496b-b2d1-0a749d58a8e8" />
<img width="1919" height="927" alt="image" src="https://github.com/user-attachments/assets/17429bb5-c609-42ff-a611-f914be4be91b" />





---

## Tech Stack

### Frontend

| Technology | Purpose |
| --- | --- |
| [Next.js](https://nextjs.org) 16 (App Router) | Framework, routing, server components |
| [React](https://react.dev) 19 | UI |
| [TypeScript](https://www.typescriptlang.org) 5 | Type-safe codebase |
| [Tailwind CSS](https://tailwindcss.com) 4 | Styling & design system |
| [Framer Motion](https://www.framer.com/motion) | Animations & transitions |

### Backend

| Technology | Purpose |
| --- | --- |
| Next.js API Routes | REST endpoints (`/api/*`) |
| [Drizzle ORM](https://orm.drizzle.team) | Type-safe SQL & migrations |
| [PostgreSQL](https://www.postgresql.org) | Primary database |
| [Supabase](https://supabase.com) | Auth (email + Google OAuth) |
| OAuth 2.0 | Google, GitHub & Discord integration auth |

### AI

| Technology | Purpose |
| --- | --- |
| [Groq](https://groq.com) | Fast LLM inference (`llama-3.3-70b-versatile` by default) |

### Tests

| Technology | Purpose |
| --- | --- |
| [Vitest](https://vitest.dev) | 150+ suites, 3,500+ unit & integration tests |

---

## Architecture

```mermaid
flowchart TD
    User[User] --> UI[Next.js Frontend]
    UI --> API[API Routes /api/*]
    API --> Auth{Authenticated?}
    Auth -- no --> SignIn[Sign-in / OAuth]
    Auth -- yes --> Orch[AI Orchestrator]
    Orch --> Planner[Tool Planner<br/>Groq + deterministic fallback]
    Planner --> Exec[Tool Executor]
    Exec --> Gmail[Gmail]
    Exec --> Cal[Google Calendar]
    Exec --> Drive[Google Drive]
    Exec --> GH[GitHub]
    Exec --> Discord[Discord]
    Exec --> TG[Telegram]
    Exec --> Result[Normalized Tool Result]
    Result --> Summary[Groq Natural-Language Summary]
    Summary --> UI
```

**Request flow:** a natural-language query is classified into a tool → the tool calls the provider's API with the user's OAuth credentials → the result is normalized → Groq writes the summary → the frontend renders it as structured cards (summary, insights, actions, sources).

---

## Project Structure

```
brieflyai/
├── app/                        # Next.js App Router
│   ├── (auth)/                 # Sign-in / sign-up pages
│   ├── dashboard/              # Dashboard, AI Assistant, Features, Integrations, Settings
│   └── api/                    # REST endpoints (integrations, AI, settings, health)
├── components/
│   ├── ai/                     # Structured AI response renderer
│   ├── dashboard/              # Sidebar, header, overview cards
│   ├── integrations/           # Integration cards, OAuth/bot-token connect dialogs
│   ├── settings/               # Settings sections & controls
│   └── features/               # Feature catalog UI
├── lib/
│   ├── ai/                     # Groq client, tool planner/executor, orchestrator
│   ├── services/               # Gmail, Calendar, Drive, GitHub, Discord, Telegram providers
│   ├── integrations/           # OAuth flows, token managers, live status store
│   ├── db/                     # PostgreSQL connection & schema
│   └── tools/                  # Tool registry & typed contracts
├── drizzle/                    # Database migrations
├── supabase/                   # Supabase configuration
├── tests/                      # Vitest suites
├── utils/                      # Supabase client/server helpers
└── package.json
```

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/brieflyai.git
cd brieflyai

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env.local   # then fill in your values (see below)

# 4. Run database migrations
npm run db:migrate

# 5. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign in with Google, then connect integrations from the **Integrations** page.

---

## Environment Variables

<details>
<summary><b>Required for the app to run</b></summary>

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (auth) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (auth) |
| `DATABASE_URL` | PostgreSQL connection string (Drizzle) |
| `GROQ_API_KEY` | Groq API key — **server only, never sent to the client** |

</details>

<details>
<summary><b>Integration OAuth credentials</b></summary>

| Variable | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client id (Gmail, Calendar, Drive) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Google OAuth callback URL |
| `GITHUB_CLIENT_ID` | GitHub OAuth client id |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `GITHUB_REDIRECT_URI` | GitHub OAuth callback URL |
| `DISCORD_CLIENT_ID` | Discord OAuth client id |
| `DISCORD_CLIENT_SECRET` | Discord OAuth client secret |
| `DISCORD_REDIRECT_URI` | Discord OAuth callback URL |

</details>

<details>
<summary><b>Optional</b></summary>

| Variable | Description |
| --- | --- |
| `GROQ_MODEL` | Override the LLM model (default `llama-3.3-70b-versatile`) |
| `DEBUG_GROQ` | Set `true` for diagnostic Groq request logging |

</details>

> **Telegram:** no server-side environment variable is needed. Users create a bot with BotFather and paste their bot token into the connect dialog — the token is validated and stored per-user on the server.

---

## Usage

Once integrations are connected, open the **AI Assistant** and ask:

| Prompt | What it does |
| --- | --- |
| `Summarize my inbox` | Digests your recent Gmail messages |
| `Find internship emails` | Searches your Gmail for matching messages |
| `What meetings do I have tomorrow?` | Lists tomorrow's calendar events |
| `Show my recent Drive files` | Returns your latest Drive files |
| `Summarize my repositories` | Summarizes your GitHub repos |
| `Show my Discord servers` | Lists the servers you're in |
| `Search my Telegram messages` | Searches chats the bot can access |

---

## Design Goals

- **Modern SaaS UI** — polished, product-grade interface
- **Responsive design** — clean at 320px through 1920px (mobile drawer, adaptive grids)
- **Accessibility** — semantic markup, keyboard support, ARIA roles, reduced-motion-safe
- **Dark theme** — full light/dark/system theming, persisted per user
- **Secure OAuth authentication** — standard flows, no custom password schemes
- **AI-first experience** — every screen helps you get to the assistant faster

---

## Security

- **OAuth 2.0 authentication** for every integration — no third-party passwords
- **No password storage** — app auth is delegated to Supabase (email + Google)
- **Secure token handling** — tokens live server-side, are rotated/refreshed, and are never exposed to the frontend, logs, or API responses
- **Environment variable protection** — secrets (`GROQ_API_KEY`, client secrets) are read only on the server
- **Principle of least privilege** — integrations request read-only scopes; destructive actions always require explicit confirmation

---

## Current Limitations

- **Discord** — channel/message access requires a Discord Bot; OAuth alone only exposes server listing.
- **Telegram** — the bot can only see chats it has been added to and received an update from.
- **AI responses** depend on which integrations are connected — answers are only as good as the live data available.

---

## Roadmap

- [ ] Slack integration
- [ ] Outlook integration
- [ ] Notion integration
- [ ] AI Actions (perform tasks, not just read)
- [ ] More workspace connectors

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and add tests
4. Run the checks:

```bash
npx tsc --noEmit   # typecheck
npm test           # 150+ Vitest suites
npm run build      # production build
```

5. Open a pull request with a clear description of the change

Please keep changes focused, preserve the existing conventions, and don't introduce unrelated refactors.

---

## License

This project is licensed under the [MIT License](LICENSE) — see the `LICENSE` file for details.

---

## Acknowledgements

- [Next.js](https://nextjs.org)
- [Supabase](https://supabase.com)
- [Groq](https://groq.com)
- [Google APIs](https://developers.google.com)
- [GitHub API](https://docs.github.com/rest)
- [Discord API](https://discord.com/developers/docs)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Tailwind CSS](https://tailwindcss.com)
- [Framer Motion](https://www.framer.com/motion)
- [Drizzle ORM](https://orm.drizzle.team)
