import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

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
    "enrollmentYear": 2012,
    "primarySpecialization": "Corporate & Business Law",
    "specializations": [
      "Company Law",
      "Contracts",
      "Startup Law",
      "Corporate Compliance"
    ],
    "yearsOfExperience": 14,
    "bio": "Corporate and business lawyer with extensive experience advising startups, entrepreneurs, and companies on contracts, incorporation, compliance, and commercial matters.",
    "city": "New Delhi",
    "languages": [
      "English",
      "Hindi"
    ],
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
    "enrollmentYear": 2016,
    "primarySpecialization": "Criminal Law",
    "specializations": [
      "Criminal Defense",
      "Bail",
      "Cybercrime",
      "White Collar Crime"
    ],
    "yearsOfExperience": 10,
    "bio": "Criminal defense lawyer handling bail applications, criminal trials, cybercrime matters, and white-collar criminal cases with a focus on practical legal representation.",
    "city": "Mumbai",
    "languages": [
      "English",
      "Hindi",
      "Marathi"
    ],
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
    "enrollmentYear": 2014,
    "primarySpecialization": "Family & Divorce Law",
    "specializations": [
      "Divorce",
      "Child Custody",
      "Alimony",
      "Domestic Violence"
    ],
    "yearsOfExperience": 12,
    "bio": "Family law specialist assisting clients with divorce, child custody, maintenance, alimony, and other family-related legal matters with a client-focused approach.",
    "city": "Bengaluru",
    "languages": [
      "English",
      "Hindi",
      "Kannada"
    ],
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
    "enrollmentYear": 2010,
    "primarySpecialization": "Property & Real Estate Law",
    "specializations": [
      "Property Disputes",
      "Land Law",
      "Real Estate",
      "Rent Disputes"
    ],
    "yearsOfExperience": 16,
    "bio": "Experienced property and real estate lawyer dealing with property disputes, land documentation, tenancy matters, title issues, and real estate transactions.",
    "city": "Pune",
    "languages": [
      "English",
      "Hindi",
      "Marathi"
    ],
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
    "enrollmentYear": 2018,
    "primarySpecialization": "Intellectual Property Law",
    "specializations": [
      "Trademark",
      "Copyright",
      "Patent",
      "Brand Protection"
    ],
    "yearsOfExperience": 8,
    "bio": "Intellectual property lawyer helping businesses and creators with trademarks, copyrights, patents, brand protection, and IP-related legal disputes.",
    "city": "Hyderabad",
    "languages": [
      "English",
      "Hindi",
      "Telugu"
    ],
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
    console.log(`\nCreating user: ${lawyer.email}`);

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: lawyer.email,
      password: lawyer.password,
      email_confirm: true,
      user_metadata: {
        first_name: lawyer.firstName,
        last_name: lawyer.lastName,
        role: 'lawyer'
      }
    });

    if (authError) {
      if (authError.message.includes('A user with this email address has already been registered') || authError.message.includes('already has an account')) {
        console.log(`-> User ${lawyer.email} already exists in auth. Skipping creation...`);
      } else {
        console.error(`-> Error creating auth user: ${authError.message}`);
        continue;
      }
    }
    
    const { data: usersData } = await supabase.auth.admin.listUsers();
    const user = authData?.user || usersData?.users.find(u => u.email === lawyer.email);

    if (!user) {
      console.error('-> Could not retrieve user ID');
      continue;
    }

    const accountId = user.id;

    console.log(`-> Creating lawyer profile for ${accountId}`);
    const { error: profileError } = await supabase
      .from('lawyer_profiles')
      .upsert({
        account_id: accountId,
        first_name: lawyer.firstName,
        last_name: lawyer.lastName,
        bar_council_number: lawyer.barCouncilNumber,
        enrollment_year: lawyer.enrollmentYear,
        primary_specialization: lawyer.primarySpecialization,
        specializations: lawyer.specializations,
        years_experience: lawyer.yearsOfExperience,
        bio: lawyer.bio,
        consultation_fee_chat: lawyer.pricing.chatPerMinute,
        consultation_fee_voice: lawyer.pricing.voicePerMinute,
        consultation_fee_video: lawyer.pricing.videoPerMinute,
        verification_status: 'verified',
        is_online: true,
        avg_rating: (4.5 + Math.random() * 0.4).toFixed(1),
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
