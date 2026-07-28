# BrieflyAI Backend

Express.js + TypeScript backend for the BrieflyAI application.

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start development server (with hot reload)
npm run dev
```

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Start compiled production server |
| `npm run lint` | Lint source code |
| `npm run clean` | Remove dist directory |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/v1/health` | Health check (versioned) |

## Project Structure

```
backend/
├── src/
│   ├── config/        # Environment config
│   ├── constants/     # App-wide constants
│   ├── controllers/   # Request handlers
│   ├── middleware/     # Express middleware
│   ├── routes/        # Route definitions
│   ├── services/      # Business logic (future)
│   ├── types/         # TypeScript types (future)
│   ├── utils/         # Utility functions (future)
│   ├── prisma/        # Prisma client (future)
│   ├── app.ts         # Express app setup
│   └── server.ts      # Server entry point
├── prisma/            # Prisma schema (future)
├── package.json
├── tsconfig.json
└── .env.example
```
