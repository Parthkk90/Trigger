# FlowLink Backend (MVP)

## Start

1. Ensure PostgreSQL is running and create database:
   createdb flowlink
2. Run migration:
   psql postgres://postgres:postgres@localhost:5432/flowlink -f backend/migrations/001_workflows.sql
3. Install dependencies from project root:
   npm install
4. Copy env template if needed:
   cp backend/.env.example backend/.env
5. Run:
   node backend/server.js

Default URL: http://localhost:8787

## Endpoints

- GET /health
- POST /api/workflows
- GET /api/workflows/:id
- GET /api/links/:slug
- GET /l/:slug

## Notes

- /l/:slug now detects whether FlowLink extension is installed.
- If extension is available, user can click "Replay In This Tab".
- If extension is not detected, the page shows a clear install CTA.

## Example POST Body

{
  "id": "abc123",
  "name": "Workflow Demo",
  "startUrl": "https://example.com",
  "steps": []
}
