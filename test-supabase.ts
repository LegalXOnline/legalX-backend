import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function test() {
  console.log('Testing Supabase Connection...');
  const { data, error } = await supabase
    .from('leads')
    .insert([
      {
        name: 'Test Lead via Script',
        phone: '1112223333',
        email: 'test@script.com',
        service_slug: 'gst-registration',
        service_title: 'GST Registration',
      }
    ])
    .select();

  if (error) {
    console.error('Error inserting lead:', error);
  } else {
    console.log('Success! Inserted lead:', data);
  }
}

test();
