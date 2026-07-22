# LegalX Backend

The backend API service for the LegalX Online platform. Built with Express, TypeScript, and Supabase.

## Architecture

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL (Supabase)
- **Payments**: Razorpay
- **Emails**: Resend

## Setup Instructions

1. Install dependencies:
```bash
npm install
```

2. Environment Variables
Create a `.env` file in the root directory and configure the following variables (see `.env.example`):
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RESEND_API_KEY=
ADMIN_EMAIL=
ALLOWED_ORIGINS=
PORT=4000
NODE_ENV=development
```

3. Database Setup
Execute the contents of `schema.sql` in your Supabase SQL editor. This will set up the required tables, enums, triggers, and Row Level Security (RLS) policies within the default public schema.

4. Start the Development Server:
```bash
npm run dev
```

## Available Scripts

- `npm run dev`: Starts the development server using tsx in watch mode.
- `npm run build`: Compiles TypeScript source files into the dist directory.
- `npm start`: Runs the compiled production build.

## Core Routes

- `/api/leads`: Lead capture and email notifications
- `/api/applications`: Service document submission and data processing
- `/api/payment`: Razorpay order creation and cryptographic verification
