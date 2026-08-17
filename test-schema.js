const dotenv = require('dotenv');
const fs = require('fs');
dotenv.config();

fetch(process.env.SUPABASE_URL + '/rest/v1/', {
  headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
}).then(r => r.json()).then(d => {
  console.log(Object.keys(d.definitions.lawyer_profiles.properties));
});
