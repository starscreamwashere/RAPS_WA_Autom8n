// Placeholder entrypoint so `docker compose up` boots end to end.
// Real routes land after the design in docs/DESIGN.md is confirmed.
const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'raps-powerplay-api' });
});

const port = Number(process.env.API_PORT) || 3000;
app.listen(port, () => {
  console.log(`raps-powerplay-api listening on :${port}`);
});
