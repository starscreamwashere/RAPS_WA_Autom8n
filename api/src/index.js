const config = require('./config');
const { createApp } = require('./app');

if (!config.apiKey) {
  console.error('API_KEY is not set; refusing to start without auth.');
  process.exit(1);
}
if (!config.ownerPhone) {
  console.warn('OWNER_PHONE is not set; owner commands are disabled.');
}

createApp().listen(config.port, () => {
  console.log(`raps-powerplay-api listening on :${config.port}`);
});
