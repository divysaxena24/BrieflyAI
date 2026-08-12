This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment variables

Copy the values into a local `.env.local` file (gitignored):

```bash
# Required for the AI tool layer (natural-language summaries).
# Get a key at https://console.groq.com/keys
GROQ_API_KEY=

# Optional: override the Groq model (defaults to llama-3.3-70b-versatile).
# GROQ_MODEL=
```

The `GROQ_API_KEY` is read only on the server (`lib/ai/groq.ts`) — it is never
sent to the frontend, logged, or included in API responses or tool results.

## AI Tools layer

Natural-language requests against your connected integrations are handled by
the AI orchestrator (`lib/ai/orchestrator.ts`):

```text
query → tool planner (Groq, deterministic fallback)
     → tool executor (existing integration services)
     → normalized tool result
     → Groq natural-language response
     → frontend
```

The 21 AI tools (`lib/ai/tools/`) wrap the existing Gmail, Calendar, Drive,
GitHub, Discord, and Telegram services — no tokens ever reach the frontend,
and every summary is generated from real integration data. Try them from the
**AI Assistant** page (`/dashboard/ai-chat`), e.g. "Summarize my inbox",
"What's on my calendar today?", or "What are the important open GitHub issues?".

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
