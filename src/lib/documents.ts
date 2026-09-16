// GENERATED FILE — do not edit.
// Mirror of legalx-web/lib/documents.ts, copied by scripts/sync-documents.mjs.
// Edit the web copy, then re-run the script.

// Central service/document registry.
// Each slug maps to one route: /documents/[slug] and /request/[slug]

export interface DocumentFaq {
  q: string
  a: string
}

export interface RequiredDoc {
  id: string
  name: string
  desc: string
  required: boolean
  acceptedFormats: string
  iconKey: 'pan' | 'aadhaar' | 'biz-cert' | 'id-proof' | 'address' | 'bank' | 'auth-letter' | 'rent' | 'photo' | 'noc' | 'food-list' | 'logo' | 'pan-card' | 'udyam' | 'biz-proof'
}

export interface FormField {
  id: string
  label: string
  type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'number' | 'textarea'
  placeholder?: string
  options?: string[]
  required: boolean
  group: string
}

export interface DocumentPricing {
  drafting: number
  govtDuty: string
  platformFee: number
  total: string
}

export interface LegalDocument {
  slug: string
  title: string
  shortDesc: string
  tag: string
  tagline: string
  price: string
  duration: string
  legalAct: string
  definition: string
  definitionQuote: string
  definitionSource: string
  keyPoints: string[]
  benefits: string[]
  features: string[]
  faqs: DocumentFaq[]
  requiredDocs: RequiredDoc[]
  formFields: FormField[]
  pricing: DocumentPricing
  estimatedTime: string
}

export const DOCUMENTS: LegalDocument[] = [

  // ─── 1. GST Registration ────────────────────────────────────────────────────
  {
    slug: 'gst-registration',
    title: 'GST Registration',
    tag: 'LEGAL SERVICE',
    shortDesc: 'GST Registration is mandatory for businesses with a turnover exceeding ₹40 lakh (₹20 lakh for service providers).',
    tagline: 'Apply online',
    price: 'From ₹499',
    duration: '3–7 working days',
    legalAct: 'Central Goods and Services Tax Act, 2017',
    estimatedTime: '~7 minutes',
    definition:
      'GST (Goods and Services Tax) Registration is mandatory for businesses with a turnover exceeding ₹40 lakh (₹20 lakh for service providers). It provides your business with a unique 15-digit GSTIN that enables you to collect tax from customers, claim input tax credit, and transact legally across India.',
    definitionQuote:
      '"Every supplier shall be liable to be registered under this Act in the State or Union territory from where he makes a taxable supply of goods or services." — CGST Act, 2017, Section 22',
    definitionSource: 'Central Goods and Services Tax Act, 2017',
    features: [
      'Mandatory for businesses above ₹40L turnover',
      'Enables Input Tax Credit (ITC) claims',
      'Required for e-commerce platform sales',
    ],
    keyPoints: [
      'Threshold limit — ₹40 lakh for goods, ₹20 lakh for services (₹10 lakh in special states)',
      'Composition Scheme — available for businesses up to ₹1.5 crore turnover',
      'GSTIN — unique 15-digit registration number issued by the GST portal',
      'Input Tax Credit — offset your purchase GST against your output GST liability',
      'Returns filing — GSTR-1, GSTR-3B to be filed monthly or quarterly',
      'Penalty for non-registration — ₹10,000 or 10% of tax due, whichever is higher',
    ],
    pricing: {
      drafting: 499,
      govtDuty: 'Nil',
      platformFee: 0,
      total: '₹499',
    },
    benefits: [
      'Legally collect GST from customers and issue tax invoices',
      'Claim Input Tax Credit (ITC) on purchases to reduce tax burden',
      'Sell across all states without legal restrictions on inter-state trade',
      'List and sell on e-commerce platforms like Amazon, Flipkart, and Meesho',
      'Enhance business credibility with government-verified GSTIN',
      'Access government tenders and contracts that require GST registration',
    ],
    requiredDocs: [
      { id: 'pan', name: 'PAN Card of Applicant / Proprietor', desc: 'PAN card of the business owner or authorized signatory.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'pan' },
      { id: 'aadhaar', name: 'Aadhaar Card', desc: 'Aadhaar of the proprietor, partners, or directors.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'aadhaar' },
      { id: 'biz-proof', name: 'Business Registration / Incorporation Certificate', desc: 'Partnership deed, Certificate of Incorporation, or any registration proof.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'biz-cert' },
      { id: 'director-id', name: 'Identity & Address Proof of Promoters / Directors', desc: 'Voter ID, Passport, or Driving Licence of all directors or partners.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'id-proof' },
      { id: 'biz-address', name: 'Address Proof of Place of Business', desc: 'Electricity bill, water bill, or property tax receipt of the principal place of business.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'address' },
      { id: 'bank-stmt', name: 'Bank Account Statement / Cancelled Cheque', desc: 'Bank statement or cancelled cheque showing your business bank account.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'bank' },
      { id: 'auth-letter', name: 'Letter of Authorization / Board Resolution', desc: 'Required for companies and LLPs to authorize a person for GST registration.', required: false, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'auth-letter' },
      { id: 'rent-agr', name: 'Rent Agreement (if PPOB is rented)', desc: 'Rental agreement of the principal place of business if the premises are not owned.', required: false, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'rent' },
    ],
    formFields: [
      { id: 'biz-name', label: 'Business / Trade Name', type: 'text', placeholder: 'Legal name of your business', required: true, group: 'Business Details' },
      { id: 'biz-type', label: 'Constitution of Business', type: 'select', options: ['Proprietorship', 'Partnership Firm', 'Private Limited Company', 'LLP', 'Hindu Undivided Family (HUF)', 'Trust / Society', 'Other'], required: true, group: 'Business Details' },
      { id: 'biz-category', label: 'Nature of Business', type: 'select', options: ['Manufacturer', 'Trader / Retailer / Wholesaler', 'Service Provider', 'E-commerce Operator', 'Works Contractor', 'Other'], required: true, group: 'Business Details' },
      { id: 'biz-address-field', label: 'Principal Place of Business Address', type: 'textarea', placeholder: 'Full address including pin code', required: true, group: 'Business Details' },
      { id: 'owner-name', label: 'Applicant / Proprietor Full Name', type: 'text', placeholder: 'As on PAN card', required: true, group: 'Applicant Details' },
      { id: 'owner-pan', label: 'PAN Number', type: 'text', placeholder: 'ABCDE1234F', required: true, group: 'Applicant Details' },
      { id: 'owner-aadhaar', label: 'Aadhaar Number', type: 'text', placeholder: 'XXXX XXXX XXXX', required: true, group: 'Applicant Details' },
      { id: 'owner-mobile', label: 'Registered Mobile Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Applicant Details' },
      { id: 'owner-email', label: 'Email Address', type: 'email', placeholder: 'business@example.com', required: true, group: 'Applicant Details' },
      { id: 'turnover', label: 'Approximate Annual Turnover', type: 'select', options: ['Below ₹20 lakh', '₹20–40 lakh', '₹40 lakh – 1 crore', '₹1 crore – 5 crore', 'Above ₹5 crore'], required: true, group: 'Additional Details' },
      { id: 'state', label: 'State of Registration', type: 'select', options: ['Bihar', 'Delhi', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'West Bengal', 'Jharkhand', 'Other'], required: true, group: 'Additional Details' },
    ],
    faqs: [
      { q: 'Who must register for GST?', a: 'Any business with an aggregate annual turnover exceeding ₹40 lakh for goods (₹20 lakh for services) must register. Certain businesses like e-commerce operators and inter-state suppliers must register regardless of turnover.' },
      { q: 'How long does GST registration take?', a: 'Typically 3–7 working days once documents and Aadhaar e-KYC are verified. Physical verification cases may take longer.' },
      { q: 'What is a GSTIN?', a: 'GSTIN is a 15-digit unique identification number assigned to every GST-registered entity. The first two digits indicate the state code, the next 10 are the PAN, and the last three identify the business type and check digit.' },
      { q: 'Can I apply for GST registration voluntarily?', a: 'Yes. Businesses below the threshold can opt for voluntary registration under Section 25(3) of the CGST Act to claim ITC and build credibility with larger buyers.' },
    ],
  },

  // ─── 2. Monthly GST Return Filing ───────────────────────────────────────────
  {
    slug: 'gst-return-filing',
    title: 'Monthly GST Return Filing',
    tag: 'TAX SERVICE',
    shortDesc: 'Every GST-registered business must file GSTR-1 and GSTR-3B every month to stay compliant. Miss a deadline and penalties start from day one.',
    tagline: 'Subscribe now',
    price: 'From ₹499/month',
    duration: 'Filed by the 20th of every month',
    legalAct: 'Central Goods and Services Tax Act, 2017',
    estimatedTime: '~5 minutes to subscribe',
    definition:
      'Monthly GST Return Filing is the ongoing compliance process every GST-registered business must complete — reporting outward supplies (GSTR-1) and paying self-assessed tax (GSTR-3B) each month. It keeps your GSTIN active, protects your Input Tax Credit, and avoids compounding late fees and interest.',
    definitionQuote:
      '"Every registered person... shall furnish, electronically, the details of outward supplies of goods or services... in such form and manner as may be prescribed." — CGST Act, 2017, Section 37',
    definitionSource: 'Central Goods and Services Tax Act, 2017',
    features: [
      'Mandatory monthly/quarterly compliance for every GST-registered business',
      'Avoid late fees of ₹50/day (₹20/day for NIL returns)',
      'Dedicated CA reviews your filing every cycle',
    ],
    keyPoints: [
      'GSTR-1 — outward supply (sales) return, due by the 11th of the following month',
      'GSTR-3B — monthly self-assessed summary return and tax payment, due by the 20th',
      'QRMP Scheme — quarterly filing option available for turnover up to ₹5 crore',
      'Late fee — ₹50/day for regular returns, ₹20/day for NIL returns, plus 18% p.a. interest on outstanding tax',
      'ITC reconciliation — matched against vendor filings every month to prevent mismatches',
    ],
    pricing: {
      drafting: 499,
      govtDuty: 'Nil',
      platformFee: 0,
      total: '₹499/month',
    },
    benefits: [
      'Never miss a due date — automated reminders and CA-managed filing',
      'Avoid late fees and interest that compound daily',
      'Protect your Input Tax Credit through proactive vendor reconciliation',
      'Maintain a clean GST compliance rating for loans, tenders, and audits',
      'One dedicated CA reviews your filing, not a rotating queue',
      'Simple monthly invoice upload — no accounting software required',
    ],
    requiredDocs: [
      { id: 'sales-invoices', name: 'Sales Invoices for the Month', desc: 'All outward supply invoices issued during the month.', required: true, acceptedFormats: 'PDF, XLS, JPG (Max 5MB each)', iconKey: 'biz-cert' },
      { id: 'purchase-invoices', name: 'Purchase Invoices / Bills for the Month', desc: 'All inward supply invoices received during the month.', required: true, acceptedFormats: 'PDF, XLS, JPG (Max 5MB each)', iconKey: 'food-list' },
      { id: 'bank-stmt', name: 'Bank Statement for the Month', desc: 'Bank statement for reconciliation of receipts and payments.', required: true, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'bank' },
      { id: 'prev-return', name: "Previous Month's GST Return Acknowledgement", desc: 'Acknowledgement copy of the last filed GST return.', required: true, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'noc' },
      { id: 'cdn', name: 'Credit/Debit Notes Issued (if any)', desc: 'Any credit or debit notes issued during the month.', required: false, acceptedFormats: 'PDF, XLS (Max 5MB)', iconKey: 'auth-letter' },
      { id: 'eway', name: 'E-way Bills Generated (if applicable)', desc: 'E-way bills generated for goods movement during the month.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'biz-proof' },
    ],
    formFields: [
      { id: 'gstin', label: 'GSTIN', type: 'text', placeholder: '15-digit GSTIN', required: true, group: 'GST Details' },
      { id: 'filing-freq', label: 'Filing Frequency', type: 'select', options: ['Monthly', 'Quarterly (QRMP)'], required: true, group: 'GST Details' },
      { id: 'biz-name', label: 'Business Name', type: 'text', placeholder: 'Registered business name', required: true, group: 'GST Details' },
      { id: 'contact-name', label: 'Contact Person Name', type: 'text', placeholder: 'Name for correspondence', required: true, group: 'Contact Details' },
      { id: 'contact-mobile', label: 'Mobile Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Contact Details' },
      { id: 'contact-email', label: 'Email Address', type: 'email', placeholder: 'filing@example.com', required: true, group: 'Contact Details' },
    ],
    faqs: [
      { q: 'What happens if I file late?', a: 'A late fee of ₹50/day (₹20/day for NIL returns) applies per return, along with 18% per annum interest on any unpaid tax.' },
      { q: 'Do I need to file even with zero sales?', a: 'Yes. A NIL return is mandatory every period your GSTIN is active, even with no transactions.' },
      { q: 'Can I switch from monthly to quarterly filing?', a: 'Yes, if your aggregate turnover is up to ₹5 crore, you can opt into the QRMP scheme at the start of a quarter.' },
      { q: "What if my vendor hasn't filed their GST return?", a: 'Your Input Tax Credit may be affected. Our CA flags mismatches during reconciliation so you can follow up with the vendor before it impacts your filing.' },
    ],
  },

  // ─── 3. Trademark Registration ──────────────────────────────────────────────
  {
    slug: 'trademark-registration',
    title: 'Trademark Registration',
    tag: 'LEGAL SERVICE',
    shortDesc: 'Trademark Registration protects your brand name, logo, or slogan under the Trade Marks Act, 1999 — giving you exclusive legal rights to use it across India.',
    tagline: 'Apply online',
    price: 'From ₹1,499',
    duration: 'Filed within 24–48 hours',
    legalAct: 'Trade Marks Act, 1999',
    estimatedTime: '~8 minutes',
    definition:
      'Trademark Registration is the legal process of registering your brand name, logo, tagline, or a combination of these with the Trade Marks Registry under the Trade Marks Act, 1999. Once registered, you get exclusive nationwide rights to use the mark for your goods or services, and the legal standing to stop others from using an identical or deceptively similar mark.',
    definitionQuote:
      '"No person shall be entitled to institute any proceeding to prevent, or to recover damages for, the infringement of an unregistered trade mark." — Trade Marks Act, 1999, Section 27(1)',
    definitionSource: 'Trade Marks Act, 1999',
    features: [
      'Protects your brand name, logo, or tagline for 10 years',
      'MSME/Startup applicants pay 50% lower government fee',
      'Use the ™ symbol immediately after filing',
    ],
    keyPoints: [
      'Government fee — ₹4,500/class (individual, MSME, DPIIT startup) or ₹9,000/class (company, LLP)',
      'Validity — 10 years from the date of filing, renewable indefinitely every 10 years',
      'Class system — goods and services are filed under one of 45 Nice Classification classes',
      'Symbol usage — ™ can be used right after filing; ® only after registration is granted',
      'Timeline to registration — filing is instant, full registration commonly takes several months to a year',
    ],
    pricing: {
      drafting: 1499,
      govtDuty: '₹4,500/class (individual/MSME/startup) or ₹9,000/class (company/LLP)',
      platformFee: 0,
      total: '₹1,499 + Govt. fee',
    },
    benefits: [
      'Exclusive legal ownership of your brand name/logo across India',
      'Legal right to sue for infringement and claim damages',
      'Builds brand credibility and trust with customers and investors',
      'Prevents competitors from copying or diluting your brand identity',
      'Becomes a transferable, licensable business asset',
      'Required by most marketplaces and franchising/licensing deals',
    ],
    requiredDocs: [
      { id: 'logo', name: 'Logo/Wordmark Image (if applicable)', desc: 'High-resolution image of the logo or wordmark to be trademarked.', required: true, acceptedFormats: 'PNG, JPG (Max 5MB)', iconKey: 'logo' },
      { id: 'pan', name: 'PAN Card of Applicant/Business', desc: 'PAN card of the individual or company.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'pan-card' },
      { id: 'id-proof', name: 'Identity Proof of Applicant/Signatory', desc: 'Aadhaar, Passport, or Voter ID of the applicant.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'id-proof' },
      { id: 'biz-cert', name: 'Business Registration/Incorporation Certificate (if company/LLP)', desc: 'Certificate of Incorporation or registration document.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'biz-cert' },
      { id: 'udyam', name: 'Udyam Registration Certificate (for MSME fee concession)', desc: 'Required to avail the ₹4,500/class concessional government fee.', required: false, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'udyam' },
      { id: 'first-use', name: 'Proof of First Use of the Mark (if already in use)', desc: 'Invoice, advertisement, or label showing first use of the mark.', required: false, acceptedFormats: 'PDF, JPG (Max 5MB)', iconKey: 'biz-proof' },
    ],
    formFields: [
      { id: 'brand-name', label: 'Brand / Trademark Name', type: 'text', placeholder: 'The exact name to be trademarked', required: true, group: 'Trademark Details' },
      { id: 'brand-desc', label: 'Description of Goods / Services', type: 'textarea', placeholder: 'What products or services does this brand cover?', required: true, group: 'Trademark Details' },
      { id: 'tm-class', label: 'Trademark Class', type: 'select', options: ['Class 9 – Software & Electronics', 'Class 25 – Clothing & Apparel', 'Class 35 – Advertising & Business Services', 'Class 36 – Finance & Insurance', 'Class 41 – Education & Entertainment', 'Class 42 – IT & Software Services', 'Class 43 – Food & Beverage Services', 'Class 44 – Medical & Veterinary Services', 'Other (please specify)'], required: true, group: 'Trademark Details' },
      { id: 'applicant-type', label: 'Applicant Type', type: 'select', options: ['Individual', 'Startup / MSME (registered)', 'Private Limited Company', 'LLP', 'Partnership Firm', 'Other'], required: true, group: 'Applicant Details' },
      { id: 'applicant-name', label: 'Applicant Full Name / Company Name', type: 'text', placeholder: 'Legal name as on registration', required: true, group: 'Applicant Details' },
      { id: 'applicant-address', label: 'Applicant Address', type: 'textarea', placeholder: 'Full registered address', required: true, group: 'Applicant Details' },
      { id: 'applicant-email', label: 'Email Address', type: 'email', placeholder: 'contact@yourbrand.com', required: true, group: 'Applicant Details' },
      { id: 'applicant-mobile', label: 'Mobile Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Applicant Details' },
    ],
    faqs: [
      { q: 'How long does trademark registration take?', a: 'Filing is completed within 24–48 hours. Full registration (assuming no objection or opposition) typically takes several months to a little over a year, since this timeline is set by the Trade Marks Registry, not by us.' },
      { q: 'What is the MSME/Startup discount?', a: 'Individuals, Udyam-registered MSMEs, and DPIIT-recognised startups pay ₹4,500/class instead of ₹9,000/class — a 50% reduction on the government fee.' },
      { q: 'Can I use the ™ symbol immediately?', a: 'Yes, the ™ symbol can be used as soon as you file your application. The ® symbol can only be used once the trademark is officially registered.' },
      { q: 'What happens if my trademark is objected to?', a: "We'll notify you and can prepare and file a response to the examination report as an add-on service — most objections are resolved by written reply without a hearing." },
    ],
  },

  // ─── 4. Udyam (MSME) Registration ───────────────────────────────────────────
  {
    slug: 'udyam-registration',
    title: 'Udyam (MSME) Registration',
    tag: 'BUSINESS REGISTRATION',
    shortDesc: 'Udyam Registration is the official government recognition for MSMEs — unlocking lower trademark fees, priority lending, and protection against delayed payments.',
    tagline: 'Apply online',
    price: 'Free – ₹299 service fee',
    duration: '~10 minutes',
    legalAct: 'Micro, Small and Medium Enterprises Development Act, 2006',
    estimatedTime: '~5 minutes',
    definition:
      "Udyam Registration is the Government of India's official recognition system for Micro, Small, and Medium Enterprises under the MSMED Act, 2006. It's a self-declaration based, Aadhaar-linked registration done on the government's Udyam portal, and it's completely free — no professional fee is legally required, but many businesses use assisted filing to avoid errors in classification.",
    definitionQuote:
      '"The Central Government may, for the purposes of this Act, by notification, classify any class or classes of enterprises... as micro, small or medium enterprises." — Micro, Small and Medium Enterprises Development Act, 2006, Section 7',
    definitionSource: 'Micro, Small and Medium Enterprises Development Act, 2006',
    features: [
      '100% free government registration, no government fee',
      'Halves your trademark government fee',
      'Access to collateral-free MSME loans and government schemes',
    ],
    keyPoints: [
      'Eligibility — based on investment in plant/machinery and annual turnover (Micro, Small, Medium slabs)',
      'Aadhaar-based — proprietor/partner/director Aadhaar number required for self-declaration',
      'Certificate — a Udyam Registration Number and e-certificate issued instantly on approval',
      'No renewal required — Udyam Registration has no expiry or renewal fee',
      'Fee benefit — reduces trademark government fee from ₹9,000 to ₹4,500 per class',
    ],
    pricing: {
      drafting: 299,
      govtDuty: 'Nil (Government fee is zero)',
      platformFee: 0,
      total: 'Free–₹299',
    },
    benefits: [
      'Access collateral-free loans under government MSME credit schemes',
      'Protection against delayed payments from buyers (interest on delayed payment under the MSMED Act)',
      '50% reduction in trademark government filing fee',
      'Priority in government tenders reserved for MSMEs',
      'Subsidies on patent registration and industrial promotion schemes',
      'Easier access to credit rating subsidies and ISO certification reimbursement schemes',
    ],
    requiredDocs: [
      { id: 'aadhaar', name: 'Aadhaar Card of Proprietor/Partner/Director', desc: 'Aadhaar number of the authorised person for self-declaration.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'aadhaar' },
      { id: 'pan', name: 'PAN Card of Business/Applicant', desc: 'PAN card of the business entity or individual applicant.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'pan-card' },
      { id: 'address', name: 'Business Address Proof', desc: 'Electricity bill, rent agreement, or any utility bill of the business premises.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'address' },
      { id: 'bank', name: 'Bank Account Details (Account Number + IFSC)', desc: 'Bank account details for the business entity.', required: true, acceptedFormats: 'PDF, JPG (Max 5MB)', iconKey: 'bank' },
      { id: 'biz-cert', name: 'Partnership Deed / Incorporation Certificate (for firms/companies)', desc: 'Required for partnership firms, LLPs, and companies.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'biz-cert' },
      { id: 'gst-cert', name: 'GST Registration Certificate (if already GST-registered)', desc: 'Optional but useful for linking Udyam with GST records.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'biz-proof' },
    ],
    formFields: [
      { id: 'biz-name', label: 'Business Name', type: 'text', placeholder: 'Name of your enterprise', required: true, group: 'Business Details' },
      { id: 'biz-type', label: 'Type of Enterprise', type: 'select', options: ['Proprietorship', 'Partnership Firm', 'LLP', 'Private Limited Company', 'Other'], required: true, group: 'Business Details' },
      { id: 'biz-activity', label: 'Main Business Activity', type: 'select', options: ['Manufacturing', 'Services', 'Trading / Retail / Wholesale'], required: true, group: 'Business Details' },
      { id: 'owner-name', label: 'Proprietor/Director Name', type: 'text', placeholder: 'As on Aadhaar', required: true, group: 'Applicant Details' },
      { id: 'owner-aadhaar', label: 'Aadhaar Number', type: 'text', placeholder: 'XXXX XXXX XXXX', required: true, group: 'Applicant Details' },
      { id: 'owner-mobile', label: 'Mobile Number (linked to Aadhaar)', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Applicant Details' },
      { id: 'owner-email', label: 'Email Address', type: 'email', placeholder: 'msme@example.com', required: true, group: 'Applicant Details' },
    ],
    faqs: [
      { q: 'Is Udyam Registration really free?', a: 'Yes, the government charges ₹0 for Udyam Registration. Our service fee (if any) only covers assisted filing and classification accuracy checks.' },
      { q: 'Who is eligible for Udyam Registration?', a: 'Any proprietorship, partnership, LLP, or company engaged in manufacturing or services, within the investment and turnover limits notified for Micro, Small, and Medium enterprises.' },
      { q: 'Does Udyam Registration expire?', a: 'No. Once issued, the Udyam Registration Certificate is valid permanently — there is no renewal requirement.' },
      { q: 'How does Udyam help with trademark registration?', a: 'A valid Udyam certificate lets you file your trademark at the concessional ₹4,500/class government fee instead of ₹9,000/class.' },
    ],
  },

  // ─── 5. DPIIT Startup India Recognition ─────────────────────────────────────
  {
    slug: 'dpiit-startup-recognition',
    title: 'DPIIT Startup India Recognition',
    tag: 'BUSINESS REGISTRATION',
    shortDesc: 'DPIIT Recognition under the Startup India initiative unlocks tax exemptions, easier compliance, funding access, and a 50% trademark fee discount for eligible startups.',
    tagline: 'Apply online',
    price: 'From ₹499',
    duration: '7–15 working days (timeline set by DPIIT)',
    legalAct: 'DPIIT Startup India Notification, G.S.R. 127(E)',
    estimatedTime: '~10 minutes',
    definition:
      "DPIIT Startup Recognition is a government certification under the Startup India initiative that identifies your business as an officially recognised \"startup.\" It's issued by the Department for Promotion of Industry and Internal Trade and opens access to tax benefits, self-certification compliance, easier public procurement norms, and reduced trademark/patent fees.",
    definitionQuote:
      '"An entity shall be considered a Startup... up to a period of ten years from the date of incorporation/registration, if its turnover for any of the financial years since incorporation/registration has not exceeded one hundred crore rupees." — DPIIT Startup India Notification, G.S.R. 127(E)',
    definitionSource: 'DPIIT Startup India Notification, G.S.R. 127(E)',
    features: [
      'Unlocks income tax exemption under Section 80-IAC (subject to conditions)',
      '50% discount on trademark government fees',
      'Self-certification compliance under labour and environment laws',
    ],
    keyPoints: [
      'Eligibility age — entity must be less than 10 years old from date of incorporation',
      'Turnover cap — annual turnover should not have exceeded ₹100 crore in any financial year',
      'Innovation criterion — business must work toward innovation, improvement of products/services, or a scalable business model',
      'Recognition certificate — issued by DPIIT via the Startup India portal',
      'Tax benefit — eligible startups can apply separately for income tax exemption under Section 80-IAC',
    ],
    pricing: {
      drafting: 499,
      govtDuty: 'Nil',
      platformFee: 0,
      total: '₹499',
    },
    benefits: [
      '50% discount on trademark and patent government filing fees',
      'Eligibility to apply for income tax exemption under Section 80-IAC',
      'Self-certification compliance under 6 labour laws and 3 environmental laws',
      'Faster winding-up process (within 90 days) under the Insolvency and Bankruptcy Code',
      "Access to the government's Startup India Seed Fund and other funding schemes",
      'Priority access to government tenders with relaxed prior-experience/turnover criteria',
    ],
    requiredDocs: [
      { id: 'incorp-cert', name: 'Certificate of Incorporation / Registration', desc: 'Certificate of Incorporation from MCA or equivalent registration proof.', required: true, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'biz-cert' },
      { id: 'pan', name: 'PAN Card of the Entity', desc: 'PAN card of the company or LLP.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'pan-card' },
      { id: 'director-details', name: 'Details of Directors/Partners (name, address, contact)', desc: 'Information about all directors or designated partners.', required: true, acceptedFormats: 'PDF/Text', iconKey: 'id-proof' },
      { id: 'innovation-writeup', name: 'Brief Write-up on Business Innovation/Model', desc: 'Description of how the business innovates, improves products, or uses a scalable model.', required: true, acceptedFormats: 'PDF, DOC (Max 5MB)', iconKey: 'food-list' },
      { id: 'pitch-deck', name: 'Website/Pitch Deck/Product Demo Link (if available)', desc: 'Supporting evidence of your product or service.', required: false, acceptedFormats: 'Link/PDF', iconKey: 'biz-proof' },
      { id: 'funding-proof', name: 'Proof of Funding (if any external funding received)', desc: 'Term sheet, investment agreement, or bank statement showing funding.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'bank' },
    ],
    formFields: [
      { id: 'entity-name', label: 'Entity Name', type: 'text', placeholder: 'Registered company/LLP name', required: true, group: 'Entity Details' },
      { id: 'entity-type', label: 'Entity Type', type: 'select', options: ['Private Limited Company', 'LLP', 'Registered Partnership Firm'], required: true, group: 'Entity Details' },
      { id: 'incorp-date', label: 'Date of Incorporation', type: 'date', required: true, group: 'Entity Details' },
      { id: 'cin', label: 'CIN / LLPIN', type: 'text', placeholder: 'Corporate Identification Number', required: true, group: 'Entity Details' },
      { id: 'contact-name', label: 'Authorized Representative Name', type: 'text', placeholder: 'Director/Partner name', required: true, group: 'Contact Details' },
      { id: 'contact-mobile', label: 'Mobile Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Contact Details' },
      { id: 'contact-email', label: 'Email Address', type: 'email', placeholder: 'startup@example.com', required: true, group: 'Contact Details' },
    ],
    faqs: [
      { q: 'Who is eligible for DPIIT recognition?', a: 'Private limited companies, LLPs, and registered partnership firms incorporated for less than 10 years, with annual turnover under ₹100 crore, working on innovation or a scalable business model.' },
      { q: 'Does DPIIT recognition guarantee tax exemption?', a: 'No. Recognition is a prerequisite, but the income tax exemption under Section 80-IAC requires a separate application and approval from the Inter-Ministerial Board.' },
      { q: 'How long is the DPIIT certificate valid?', a: 'It remains valid until the entity crosses 10 years from incorporation or ₹100 crore turnover in any financial year, whichever is earlier.' },
      { q: 'Does DPIIT recognition help with trademark costs?', a: 'Yes. DPIIT-recognised startups pay the concessional ₹4,500/class government fee for trademark filing, same as MSMEs.' },
    ],
  },

  // ─── 6. Legal Notice Drafting ────────────────────────────────────────────────
  {
    slug: 'legal-notice-drafting',
    title: 'Legal Notice Drafting',
    tag: 'LEGAL DOCUMENT',
    shortDesc: 'A Legal Notice is a formal warning drafted by an advocate and sent before filing a case in court — for unpaid dues, cheque bounce, or tenant eviction.',
    tagline: 'Get my notice drafted',
    price: 'From ₹999',
    duration: '24–48 hours drafting',
    legalAct: 'Negotiable Instruments Act, 1881 / Code of Civil Procedure, 1908',
    estimatedTime: '~6 minutes',
    definition:
      "A Legal Notice is a formal written communication, drafted and signed by an advocate, sent to the opposing party to formally record a grievance and demand a resolution — payment of dues, vacating a property, or compliance with an obligation — before a court case is filed. For cheque bounce cases specifically, sending a notice within 30 days of the cheque being dishonoured is a mandatory legal requirement under the Negotiable Instruments Act.",
    definitionQuote:
      '"The payee or the holder in due course... makes a demand for the payment of the said amount of money by giving a notice in writing, to the drawer of the cheque, within thirty days of the receipt of information by him from the bank regarding the return of the cheque as unpaid." — Negotiable Instruments Act, 1881, Section 138(b)',
    definitionSource: 'Negotiable Instruments Act, 1881',
    features: [
      'Drafted and signed by a practicing advocate',
      'Covers recovery, cheque bounce (Section 138), and tenant eviction notices',
      'Delivered as a print-ready, signed PDF within 24–48 hours',
    ],
    keyPoints: [
      'Legal basis — cheque bounce notices are governed by Section 138, Negotiable Instruments Act, 1881',
      'Mandatory step — a legal notice is a required precondition before filing a cheque bounce complaint (must be sent within 30 days of dishonour)',
      'Response window — the recipient typically gets 15 days to respond or comply before further legal action',
      'Delivery — sent via Registered Post/Speed Post with acknowledgement (or email, if applicable), at actual courier cost',
      'Advocate-signed — every notice carries an advocate\'s name, enrollment details, and signature for legal validity',
    ],
    pricing: {
      drafting: 999,
      govtDuty: 'Courier/postage at actuals',
      platformFee: 0,
      total: '₹999 per notice',
    },
    benefits: [
      'Often resolves disputes without the cost and time of going to court',
      'Legally mandatory first step before filing a cheque bounce complaint',
      'Creates a formal, dated record of your grievance for future legal proceedings',
      'Signals seriousness and often prompts faster settlement from the other party',
      'Strengthens your position if the matter does proceed to litigation',
      'Drafted by a qualified advocate, giving the notice real legal weight',
    ],
    requiredDocs: [
      { id: 'sender-details', name: 'Your Full Name, Address & Contact Details', desc: 'Details of the person sending the notice.', required: true, acceptedFormats: 'Text', iconKey: 'id-proof' },
      { id: 'recipient-details', name: "Recipient's Full Name & Address", desc: 'Full details of the person or company receiving the notice.', required: true, acceptedFormats: 'Text', iconKey: 'address' },
      { id: 'dispute-nature', name: 'Nature of Dispute (recovery / cheque bounce / eviction / other)', desc: 'Clear description of the type of legal issue.', required: true, acceptedFormats: 'Text', iconKey: 'food-list' },
      { id: 'relevant-dates', name: 'Relevant Dates (transaction date, cheque date, dishonour date, etc.)', desc: 'All key dates relevant to the dispute.', required: true, acceptedFormats: 'Text', iconKey: 'biz-proof' },
      { id: 'supporting-docs', name: 'Supporting Documents (cheque copy, agreement, invoice, bank return memo, etc.)', desc: 'Any documents that support your legal claim.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB each)', iconKey: 'biz-cert' },
      { id: 'rent-agreement', name: 'Rent/Lease Agreement (for eviction notices)', desc: 'Required if the notice is for tenant eviction.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'rent' },
    ],
    formFields: [
      { id: 'notice-type', label: 'Type of Notice', type: 'select', options: ['Cheque Bounce (Section 138)', 'Recovery of Money', 'Tenant Eviction', 'General Legal Notice', 'Other'], required: true, group: 'Notice Details' },
      { id: 'sender-name', label: 'Your Full Name', type: 'text', placeholder: 'Name of sender', required: true, group: 'Sender Details' },
      { id: 'sender-address', label: 'Your Full Address', type: 'textarea', placeholder: 'Complete address with pin code', required: true, group: 'Sender Details' },
      { id: 'sender-mobile', label: 'Mobile Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Sender Details' },
      { id: 'sender-email', label: 'Email Address', type: 'email', placeholder: 'your@email.com', required: true, group: 'Sender Details' },
      { id: 'recipient-name', label: "Recipient's Full Name", type: 'text', placeholder: 'Name of person/company receiving notice', required: true, group: 'Recipient Details' },
      { id: 'recipient-address', label: "Recipient's Address", type: 'textarea', placeholder: 'Complete address with pin code', required: true, group: 'Recipient Details' },
      { id: 'amount', label: 'Amount Involved (if applicable)', type: 'number', placeholder: 'Amount in INR', required: false, group: 'Dispute Details' },
      { id: 'dispute-facts', label: 'Brief Facts of the Dispute', type: 'textarea', placeholder: 'Describe what happened, key dates, and what you are demanding', required: true, group: 'Dispute Details' },
    ],
    faqs: [
      { q: 'Is a legal notice mandatory before filing a case?', a: 'For cheque bounce cases under Section 138, yes — it\'s a mandatory precondition. For recovery or eviction matters, it\'s not always mandatory but is standard practice and often required under the relevant rent/tenancy laws.' },
      { q: 'How long does the recipient have to respond?', a: 'Typically 15 days is given in the notice, though the exact period depends on the nature of the dispute and applicable law.' },
      { q: 'What if the recipient ignores the notice?', a: 'You can proceed to file a formal complaint or suit in court. The notice itself becomes evidence that you gave the other party a fair opportunity to resolve the matter.' },
      { q: 'Can I send the notice by email instead of post?', a: "Registered Post/Speed Post with acknowledgment is the standard and most legally defensible method; email can be used as a supplementary channel but generally shouldn't replace physical delivery for cheque bounce and eviction notices." },
    ],
  },

  // ─── 7. Rent / Lease Agreement Drafting ─────────────────────────────────────
  {
    slug: 'rent-agreement-drafting',
    title: 'Rent / Lease Agreement Drafting',
    tag: 'LEGAL DOCUMENT',
    shortDesc: 'A Rent/Lease Agreement is a legally binding contract between a landlord and tenant, drafted by an advocate to clearly define rent, deposit, duration, and terms.',
    tagline: 'Get my agreement drafted',
    price: 'From ₹499',
    duration: '24 hours',
    legalAct: 'Registration Act, 1908',
    estimatedTime: '~6 minutes',
    definition:
      'A Rent/Lease Agreement (also called a Leave and License Agreement in many states) is a legal contract that sets out the terms under which a landlord permits a tenant to occupy a property — including rent, deposit, duration, and responsibilities of each party. A properly drafted agreement protects both the landlord\'s property rights and the tenant\'s occupancy rights, and is often required for address proof, utility connections, and business registrations.',
    definitionQuote:
      '"Leases of immovable property from year to year, or for any term exceeding one year, or reserving a yearly rent... [require] registration." — Registration Act, 1908, Section 17(1)(d)',
    definitionSource: 'Registration Act, 1908',
    features: [
      'Drafted by an advocate on legally valid stamp paper terms',
      'Covers residential, commercial, and 11-month leave-and-license formats',
      'Editable draft delivered within 24 hours',
    ],
    keyPoints: [
      '11-month rule — most rent agreements are drafted for 11 months to avoid mandatory registration under the Registration Act',
      'Registration threshold — leases for 12 months or more must be compulsorily registered under Section 17, Registration Act, 1908',
      'Stamp duty — varies by state and is charged on the stamp paper value, separate from our drafting fee',
      'Key clauses — rent amount, security deposit, notice period, maintenance responsibility, and lock-in period',
      'Notarization — optional but recommended for extra evidentiary value, especially for 11-month agreements',
    ],
    pricing: {
      drafting: 499,
      govtDuty: 'Stamp duty extra (state-specific)',
      platformFee: 0,
      total: '₹499 + Stamp duty',
    },
    benefits: [
      'Legally protects both landlord and tenant in case of disputes',
      'Serves as valid address proof for bank accounts, GST, and other registrations',
      'Clearly defines rent, deposit, and maintenance obligations to avoid confusion',
      'Protects against sudden eviction or unauthorised rent hikes',
      'Required documentation for many company incorporations and GST registrations (as proof of business address)',
      'Drafted with state-specific stamp duty and format requirements in mind',
    ],
    requiredDocs: [
      { id: 'landlord-id', name: "Landlord's Full Name, Address & ID Proof", desc: 'Aadhaar, PAN, or Voter ID of the property owner.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'id-proof' },
      { id: 'tenant-id', name: "Tenant's Full Name, Address & ID Proof", desc: 'Aadhaar, PAN, or Voter ID of the tenant.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'aadhaar' },
      { id: 'property-details', name: 'Property Address & Description', desc: 'Full address and description of the property being rented.', required: true, acceptedFormats: 'Text', iconKey: 'address' },
      { id: 'ownership-proof', name: 'Property Ownership Proof (sale deed/tax receipt)', desc: "Document proving the landlord's ownership of the property.", required: true, acceptedFormats: 'PDF, JPG (Max 5MB)', iconKey: 'biz-cert' },
      { id: 'photos', name: 'Passport-size Photographs of Both Parties', desc: 'Optional, required if notarization is needed.', required: false, acceptedFormats: 'JPG, PNG (Max 2MB)', iconKey: 'photo' },
      { id: 'witness-details', name: 'Witness Details (for notarization)', desc: 'Name and address of two witnesses if notarization is required.', required: false, acceptedFormats: 'Text', iconKey: 'noc' },
    ],
    formFields: [
      { id: 'property-type', label: 'Property Type', type: 'select', options: ['Residential – Flat/Apartment', 'Residential – Independent House', 'Commercial – Office', 'Commercial – Shop', 'Commercial – Warehouse', 'Other'], required: true, group: 'Property Details' },
      { id: 'lease-duration', label: 'Lease Duration', type: 'select', options: ['11 months (Leave & License)', '1 year', '2 years', '3 years', 'Other'], required: true, group: 'Property Details' },
      { id: 'rent-amount', label: 'Monthly Rent Amount (₹)', type: 'number', placeholder: 'Monthly rent in INR', required: true, group: 'Terms' },
      { id: 'deposit-amount', label: 'Security Deposit Amount (₹)', type: 'number', placeholder: 'Security deposit in INR', required: true, group: 'Terms' },
      { id: 'start-date', label: 'Agreement Start Date', type: 'date', required: true, group: 'Terms' },
      { id: 'landlord-name', label: "Landlord's Full Name", type: 'text', placeholder: 'As on ID proof', required: true, group: 'Landlord Details' },
      { id: 'landlord-mobile', label: "Landlord's Mobile Number", type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Landlord Details' },
      { id: 'tenant-name', label: "Tenant's Full Name", type: 'text', placeholder: 'As on ID proof', required: true, group: 'Tenant Details' },
      { id: 'tenant-mobile', label: "Tenant's Mobile Number", type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Tenant Details' },
      { id: 'tenant-email', label: "Tenant's Email Address", type: 'email', placeholder: 'tenant@example.com', required: true, group: 'Tenant Details' },
      { id: 'state', label: 'State', type: 'select', options: ['Bihar', 'Delhi', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'West Bengal', 'Jharkhand', 'Other'], required: true, group: 'Tenant Details' },
    ],
    faqs: [
      { q: 'Why are most rent agreements for 11 months?', a: 'An 11-month term avoids the mandatory registration requirement that applies to leases of 12 months or more, saving both parties registration cost and time. It can be renewed every 11 months.' },
      { q: 'Do I need to pay stamp duty separately?', a: "Yes. Stamp duty is a state government charge based on the agreement value and is separate from our drafting fee — we'll tell you the applicable amount for your state." },
      { q: 'Is notarization compulsory?', a: "No, but it's recommended for added evidentiary value, especially if the agreement may be used in a dispute later." },
      { q: 'Can this agreement be used as address proof for GST or company registration?', a: 'Yes, a properly drafted and dated rent agreement is commonly accepted as address proof for GST registration and company incorporation.' },
    ],
  },

  // ─── 8. Affidavit Drafting ───────────────────────────────────────────────────
  {
    slug: 'affidavit-drafting',
    title: 'Affidavit Drafting',
    tag: 'LEGAL DOCUMENT',
    shortDesc: 'An Affidavit is a sworn written statement drafted by an advocate and affirmed before a notary or magistrate — used for name change, address proof, income declaration, and other official purposes.',
    tagline: 'Get my affidavit drafted',
    price: 'From ₹299',
    duration: 'Within a few hours',
    legalAct: 'Indian Oaths Act, 1969 / Code of Civil Procedure, 1908',
    estimatedTime: '~4 minutes',
    definition:
      "An Affidavit is a written statement of facts, sworn to be true by the person making it (the \"deponent\"), signed before a Notary Public or Executive Magistrate. It's a legally recognised way to formally declare facts — such as a change of name, proof of address, or a declaration of income — for use with government departments, banks, employers, or courts.",
    definitionQuote:
      '"Affidavits shall be confined to such facts as the deponent is able of his own knowledge to prove." — Code of Civil Procedure, 1908, Order XIX, Rule 3',
    definitionSource: 'Code of Civil Procedure, 1908',
    features: [
      'Drafted by an advocate for your specific affidavit type',
      'Covers name change, address proof, and income declaration formats',
      'Ready-to-notarize draft delivered within a few hours',
    ],
    keyPoints: [
      'Legal basis — governed by the Indian Oaths Act, 1969 and Code of Civil Procedure, 1908 (Order XIX)',
      'Sworn statement — a false affidavit can attract criminal liability for perjury under the Bharatiya Nyaya Sanhita',
      'Notarization required — must be signed before a Notary Public or Executive Magistrate to be legally valid',
      'Stamp paper — typically drafted on non-judicial stamp paper of a state-specified value',
      'Common types — name change, address proof, income declaration, general/self-declaration affidavits',
    ],
    pricing: {
      drafting: 299,
      govtDuty: 'Notarization/stamp paper extra',
      platformFee: 0,
      total: '₹299 per affidavit',
    },
    benefits: [
      'Legally accepted proof for name change, address, or income declarations',
      'Required by banks, passport office, and government departments for identity/address mismatches',
      'Drafted in the correct legal format to avoid rejection',
      'Advocate-reviewed language reduces risk of factual or procedural errors',
      'Quick turnaround for time-sensitive applications (passport, school admission, etc.)',
      'Can be customised for general-purpose declarations not covered by a standard template',
    ],
    requiredDocs: [
      { id: 'deponent-name', name: 'Full Name & Address of Deponent', desc: 'Your full legal name and address as it should appear in the affidavit.', required: true, acceptedFormats: 'Text', iconKey: 'id-proof' },
      { id: 'affidavit-type', name: 'Type of Affidavit (name change / address proof / income declaration / general)', desc: 'Select the specific type of affidavit you need.', required: true, acceptedFormats: 'Selection', iconKey: 'food-list' },
      { id: 'id-proof', name: 'ID Proof of Deponent (Aadhaar/PAN/Passport)', desc: 'Government-issued identity proof of the person making the affidavit.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'aadhaar' },
      { id: 'supporting-docs', name: 'Supporting Documents (old ID for name change, utility bill for address, Form 16 for income, etc.)', desc: 'Documents relevant to the specific purpose of the affidavit.', required: true, acceptedFormats: 'PDF, JPG, PNG (Max 5MB)', iconKey: 'biz-cert' },
      { id: 'gazette', name: 'Gazette Notification Copy (for legal name change, if already published)', desc: 'Official gazette copy if the name change has already been published.', required: false, acceptedFormats: 'PDF (Max 5MB)', iconKey: 'biz-proof' },
      { id: 'witness', name: 'Two Witness Details (for notarization)', desc: 'Name and address of two witnesses, if notarization is planned.', required: false, acceptedFormats: 'Text', iconKey: 'noc' },
    ],
    formFields: [
      { id: 'affidavit-type', label: 'Type of Affidavit', type: 'select', options: ['Name Change', 'Address Proof', 'Income Declaration', 'General / Self-Declaration', 'Other'], required: true, group: 'Affidavit Details' },
      { id: 'purpose', label: 'Purpose of Affidavit (where it will be submitted)', type: 'text', placeholder: 'e.g. Passport office, School admission, Bank, Court', required: true, group: 'Affidavit Details' },
      { id: 'deponent-name', label: 'Full Name of Deponent', type: 'text', placeholder: 'Your full legal name', required: true, group: 'Deponent Details' },
      { id: 'deponent-address', label: 'Address of Deponent', type: 'textarea', placeholder: 'Full address with pin code', required: true, group: 'Deponent Details' },
      { id: 'deponent-mobile', label: 'Mobile Number', type: 'tel', placeholder: '+91 XXXXX XXXXX', required: true, group: 'Deponent Details' },
      { id: 'deponent-email', label: 'Email Address', type: 'email', placeholder: 'your@email.com', required: true, group: 'Deponent Details' },
      { id: 'state', label: 'State (for stamp paper value)', type: 'select', options: ['Bihar', 'Delhi', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Gujarat', 'Rajasthan', 'Uttar Pradesh', 'West Bengal', 'Jharkhand', 'Other'], required: true, group: 'Deponent Details' },
      { id: 'facts', label: 'Facts to be Declared', type: 'textarea', placeholder: 'Describe the facts you need to declare in the affidavit', required: true, group: 'Declaration' },
    ],
    faqs: [
      { q: 'Is an affidavit valid without notarization?', a: 'No. An affidavit must be signed before a Notary Public or Executive Magistrate to be legally valid — we provide the ready-to-sign draft, and notarization is completed locally or through our assisted service.' },
      { q: 'What happens if the facts in my affidavit are false?', a: 'Swearing a false affidavit is a criminal offence and can attract prosecution for perjury — always ensure the facts you declare are accurate.' },
      { q: 'How long does drafting take?', a: 'Most affidavit drafts are ready within a few hours of receiving your details, since these follow a standard legal format.' },
      { q: 'Can I use this for a passport or school admission application?', a: 'Yes, our name-change and address-proof affidavit formats are commonly accepted for passport applications, school admissions, and similar official purposes — always confirm the specific format requirement with the receiving authority.' },
    ],
  },
]

export function getDocument(slug: string): LegalDocument | undefined {
  return DOCUMENTS.find((d) => d.slug === slug)
}
