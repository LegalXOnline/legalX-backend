const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { resolve } = require('path');

dotenv.config({ path: resolve(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const lawyers = [
  {
    "firstName": "Aarav",
    "lastName": "Mehta",
    "email": "aarav.mehta@example.com",
    "password": "Test@1234A",
    "barCouncilNumber": "D/2012/18472",
    "yearsOfExperience": 14,
    "bio": "Corporate and business lawyer with extensive experience advising startups, entrepreneurs, and companies on contracts, incorporation, compliance, and commercial matters.",
    "pricing": {
      "chatPerMinute": 30,
      "voicePerMinute": 40,
      "videoPerMinute": 50
    }
  },
  {
    "firstName": "Rohan",
    "lastName": "Sharma",
    "email": "rohan.sharma@example.com",
    "password": "Test@1234B",
    "barCouncilNumber": "D/2016/29381",
    "yearsOfExperience": 10,
    "bio": "Criminal defense lawyer handling bail applications, criminal trials, cybercrime matters, and white-collar criminal cases with a focus on practical legal representation.",
    "pricing": {
      "chatPerMinute": 25,
      "voicePerMinute": 35,
      "videoPerMinute": 45
    }
  },
  {
    "firstName": "Neha",
    "lastName": "Kapoor",
    "email": "neha.kapoor@example.com",
    "password": "Test@1234C",
    "barCouncilNumber": "D/2014/37126",
    "yearsOfExperience": 12,
    "bio": "Family law specialist assisting clients with divorce, child custody, maintenance, alimony, and other family-related legal matters with a client-focused approach.",
    "pricing": {
      "chatPerMinute": 30,
      "voicePerMinute": 40,
      "videoPerMinute": 50
    }
  },
  {
    "firstName": "Vikram",
    "lastName": "Deshmukh",
    "email": "vikram.deshmukh@example.com",
    "password": "Test@1234D",
    "barCouncilNumber": "M/2010/45891",
    "yearsOfExperience": 16,
    "bio": "Experienced property and real estate lawyer dealing with property disputes, land documentation, tenancy matters, title issues, and real estate transactions.",
    "pricing": {
      "chatPerMinute": 40,
      "voicePerMinute": 50,
      "videoPerMinute": 60
    }
  },
  {
    "firstName": "Ananya",
    "lastName": "Iyer",
    "email": "ananya.iyer@example.com",
    "password": "Test@1234E",
    "barCouncilNumber": "D/2018/52643",
    "yearsOfExperience": 8,
    "bio": "Intellectual property lawyer helping businesses and creators with trademarks, copyrights, patents, brand protection, and IP-related legal disputes.",
    "pricing": {
      "chatPerMinute": 25,
      "voicePerMinute": 35,
      "videoPerMinute": 45
    }
  }
];

async function seedLawyers() {
  console.log('Starting seeder...');

  for (const lawyer of lawyers) {
    console.log(`\nProcessing: ${lawyer.email}`);
    
    // Auth users already exist from previous run! Just retrieve ID.
    const { data: usersData } = await supabase.auth.admin.listUsers();
    const user = usersData?.users.find(u => u.email === lawyer.email);

    if (!user) {
      console.error(`-> Could not retrieve user ID for ${lawyer.email}`);
      continue;
    }

    const accountId = user.id;

    // INSERT INTO ACCOUNTS FIRST
    console.log(`-> Creating account for ${accountId}`);
    const { error: accountError } = await supabase
      .from('accounts')
      .upsert({
        id: accountId,
        email: lawyer.email,
        role: 'lawyer',
        status: 'active'
      }, { onConflict: 'id' });
      
    if (accountError) {
      console.error(`-> Account Error: ${accountError.message}`);
      continue;
    }

    console.log(`-> Creating lawyer profile for ${accountId}`);
    const { error: profileError } = await supabase
      .from('lawyer_profiles')
      .upsert({
        account_id: accountId,
        first_name: lawyer.firstName,
        last_name: lawyer.lastName,
        bar_council_number: lawyer.barCouncilNumber,
        years_experience: lawyer.yearsOfExperience,
        bio: lawyer.bio,
        consultation_fee_chat: lawyer.pricing.chatPerMinute,
        consultation_fee_voice: lawyer.pricing.voicePerMinute,
        consultation_fee_video: lawyer.pricing.videoPerMinute,
        verification_status: 'verified',
        is_online: true,
        avg_rating: parseFloat((4.5 + Math.random() * 0.4).toFixed(1)),
        total_reviews: Math.floor(Math.random() * 200) + 50,
      }, { onConflict: 'account_id' });

    if (profileError) {
      console.error(`-> Profile Error: ${profileError.message}`);
    } else {
      console.log(`-> Successfully seeded ${lawyer.firstName} ${lawyer.lastName}`);
    }
  }

  console.log('\nDone.');
}

seedLawyers().catch(console.error);
