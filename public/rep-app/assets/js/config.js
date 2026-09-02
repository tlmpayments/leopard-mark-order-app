// Paste the Apps Script Web App URL here after deploying apps-script/Code.gs.
window.LM_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzC9cca_qGNFS2dbXrRvDKNuaxQRMJxmbCRV9UgMfyQjd6XTWhkntOCetqWeqKkXujNCA/exec',
  // Not a secret -- this is visible in the address bar to anyone using
  // Slack in a browser. Used to build the order-confirmation screen's
  // thread-reply link (see renderOrderConfirmation in app.js) as a real
  // https://<domain>.slack.com/archives/<channel>/p<ts>?thread_ts=<ts>
  // permalink -- the format Slack itself opens directly into a message's
  // thread panel, not just the channel scrolled to that message. Looked up
  // once via Code.gs's handleDebugSlackTeamInfo (Slack's auth.test API).
  SLACK_WORKSPACE_DOMAIN: 'leopardmark'
};

// Territory label shown under a rep's name on the home screen, in place of
// a generic "Sales Rep" tag. Keyed by the exact rep name returned by login.
window.LM_REP_REGIONS = {
  'Jack Begley': 'Northeast',
  'T. Gilbert': 'SF/Bay',
  'J. Williams': 'LA',
  'D. Krause': 'LA',
  'S. Sprague': 'South'
};
