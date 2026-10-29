import { all, get, ymd, addDays } from './db.js';

const EMERGENCY = process.env.EMERGENCY_NUMBER || '112';

/* ---------------------------------------------------------------- LLM (optional) */
export const llmEnabled = () => !!process.env.ANTHROPIC_API_KEY;
export async function callClaude({ system, messages, max_tokens = 700 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens, system, messages })
    });
    if (!r.ok) { console.warn('Claude API returned', r.status); return null; }
    const j = await r.json();
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || null;
  } catch (e) { console.warn('Claude API unavailable:', e.message); return null; }
}

/* ---------------------------------------------------------------- safety */
const RED_FLAGS = [
  [/chest (pain|pressure|tightness)|pain in (my )?chest|heart attack/i, 'chest pain or pressure'],
  [/(can'?t|cannot|unable to) breathe|difficulty breathing|severe(ly)? short(ness)? of breath|gasping/i, 'severe difficulty breathing'],
  [/face (is )?droop|slurred speech|sudden(ly)? (weak|numb)|one side (of my )?(body|face)|stroke/i, 'possible stroke signs'],
  [/unconscious|passed out|not responding|fainted and/i, 'loss of consciousness'],
  [/seizure|convulsion|fitting/i, 'seizure'],
  [/(severe|heavy|uncontrolled) bleeding|bleeding (won'?t|will not) stop|vomiting blood|coughing (up )?blood/i, 'severe bleeding'],
  [/anaphyla|throat (is )?(closing|swelling)|swollen (tongue|lips) and (breath|wheez)/i, 'severe allergic reaction'],
  [/overdose|poison|swallowed (a lot|bleach|pills)/i, 'possible poisoning or overdose'],
  [/pregnan\w+.*(heavy bleeding|severe pain)|(heavy bleeding|severe pain).*pregnan/i, 'pregnancy complication']
];
const CRISIS = /suicid|kill myself|end my life|want to die|self[- ]?harm|hurt myself|no reason to live/i;

export function safetyCheck(text = '') {
  if (CRISIS.test(text)) return { level: 'crisis', reason: 'thoughts of self-harm' };
  for (const [re, reason] of RED_FLAGS) if (re.test(text)) return { level: 'emergency', reason };
  return null;
}
const emergencyReply = s => s.level === 'crisis'
  ? `I'm really glad you told me, and I'm concerned about you. You deserve support right now.\n\n• If you might act on these thoughts or are in immediate danger, call your local emergency number (${EMERGENCY} in India) or go to the nearest emergency room.\n• In India you can also reach Tele-MANAS at 14416 (free, 24/7) to talk to a trained counsellor.\n• If you can, tell someone you trust that you need company tonight.\n\nI can also help you book an urgent chat with one of our mental wellness doctors. You don't have to carry this alone.`
  : `What you describe (${s.reason}) can be serious.\n\n**Please call your local emergency number (${EMERGENCY} in India) or go to the nearest emergency room now.** Don't wait for an online appointment, and avoid driving yourself if you feel unwell.\n\nOnce you are safe, I can help you book a follow-up with a doctor.`;

/* ---------------------------------------------------------------- knowledge */
const CLUSTERS = [
  { id: 'cardio', specialty: 'Cardiology', words: ['palpitation', 'heart racing', 'blood pressure', ' bp ', 'hypertension', 'swollen legs', 'swelling in legs', 'heart', 'cholesterol', 'dizzy on standing'],
    possible: ['Blood pressure changes', 'Heart rhythm irregularity (palpitations)', 'Anxiety-related heart racing'], care: ['Sit down, breathe slowly and rest for 10 minutes', 'Limit caffeine, salt and alcohol', 'Log your blood pressure and pulse in the Health tracker'], ask: ['Do you get symptoms with exertion or at rest?', 'Any family history of heart disease?'] },
  { id: 'derm', specialty: 'Dermatology', words: ['rash', 'itch', 'acne', 'pimple', 'eczema', 'psoriasis', 'hair fall', 'hair loss', 'dandruff', 'skin', 'hives', 'allergy on skin', 'fungal'],
    possible: ['Contact or allergic dermatitis', 'Eczema or dry-skin condition', 'Fungal skin infection'], care: ['Use a gentle fragrance-free moisturiser', 'Avoid scratching and new skincare or detergents', 'Take a clear photo of the area to share with the doctor'], ask: ['When did it start and is it spreading?', 'Any new products, foods or medicines recently?'] },
  { id: 'mind', specialty: 'Mental Wellness', words: ['anxiety', 'anxious', 'stress', 'depress', 'panic', 'insomnia', "can't sleep", 'cannot sleep', 'low mood', 'overthinking', 'sad ', 'burnout', 'mood swings', 'lonely'],
    possible: ['Stress or anxiety response', 'Low mood or adjustment difficulty', 'Sleep disturbance'], care: ['Try slow breathing: inhale 4s, hold 4s, exhale 6s for five minutes', 'Keep a regular sleep time and avoid screens an hour before bed', 'Talk to someone you trust today'], ask: ['How long have you felt this way?', 'Is it affecting sleep, work or relationships?'] },
  { id: 'peds', specialty: 'Pediatrics', words: ['my child', 'my son', 'my daughter', 'my baby', 'infant', 'toddler', 'newborn', 'kid '],
    possible: ['Common childhood viral illness', 'Feeding or growth concern', 'Childhood allergy'], care: ['Keep the child hydrated and comfortable', 'Dress lightly if there is fever', 'Watch for drowsiness, refusal to feed or breathing difficulty'], ask: ["What is your child's age and weight?", 'Is your child feeding and passing urine normally?'] },
  { id: 'ortho', specialty: 'Orthopedics', words: ['back pain', 'knee', 'joint', 'fracture', 'sprain', 'shoulder', 'neck pain', 'muscle pain', 'ankle', 'sciatica', 'arthritis', 'hip pain', 'wrist'],
    possible: ['Muscle strain or ligament sprain', 'Mechanical joint or spine pain', 'Early arthritis'], care: ['Rest the area and avoid heavy lifting', 'Cold pack for 15 minutes in the first 48 hours after an injury', 'Gentle movement once pain eases'], ask: ['Was there an injury or fall?', 'Any numbness, weakness or night pain?'] },
  { id: 'gyn', specialty: 'Gynecology', words: ['period', 'menstrua', 'pregnan', 'pcos', 'pcod', 'irregular cycle', 'vaginal', 'breast lump', 'menopause', 'missed period'],
    possible: ['Hormonal or cycle irregularity', 'PCOS-related symptoms', 'Pregnancy-related concern'], care: ['Track your cycle dates and symptoms', 'Stay hydrated and rest', 'Avoid self-medicating with hormonal tablets'], ask: ['When was your last period?', 'Is there pelvic pain or unusual bleeding?'] },
  { id: 'ent', specialty: 'ENT', words: ['ear pain', 'earache', 'hearing', 'sinus', 'sore throat', 'throat', 'tonsil', 'blocked nose', 'nose block', 'nosebleed', 'tinnitus', 'ringing in'],
    possible: ['Sinus or nasal congestion', 'Throat or tonsil infection', 'Ear infection or wax build-up'], care: ['Warm saline gargles or steam inhalation', 'Stay hydrated and rest your voice', 'Avoid putting objects in the ear'], ask: ['Any fever or discharge from the ear or nose?', 'How many days has it lasted?'] },
  { id: 'gen', specialty: 'General Medicine', words: ['fever', 'cold', 'cough', 'body ache', 'fatigue', 'tired', 'weakness', 'headache', 'migraine', 'nausea', 'vomit', 'diarrh', 'stomach', 'acidity', 'gas', 'constipation', 'dizz', 'loss of appetite', 'weight loss', 'diabet', 'sugar', 'thyroid', 'chills'],
    possible: ['Viral infection', 'Dehydration or fatigue', 'Gastric irritation or acidity', 'Tension-type headache'], care: ['Rest and drink plenty of fluids', 'Eat light, easily digestible food', 'Monitor your temperature every 6 hours'], ask: ['How many days have you had these symptoms?', 'Do you have any long-term conditions or allergies?'] }
];
const URGENT = /(fever|temperature).*(3|three|4|four|5|five|\d+) days|(103|104|105)\s*°?f?|persistent vomit|blood in (stool|urine)|severe (pain|headache)|worst headache|(can'?t|cannot) keep (anything|fluids) down|dehydrat|infant.*fever|baby.*fever|swelling.*(face|one leg)|sudden vision/i;
const MILD = /mild|slight|runny nose|sneez|minor/i;

export async function triage({ text = '', age, duration = '', severity = '' }) {
  const lower = ` ${text.toLowerCase()} `;
  const safety = safetyCheck(text);
  const scored = CLUSTERS.map(c => ({ c, score: c.words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  let top = scored[0]?.c || CLUSTERS.at(-1);
  if (Number(age) && Number(age) < 14) top = CLUSTERS.find(c => c.id === 'peds');
  let urgency = 'routine';
  if (safety) urgency = 'emergency';
  else if (URGENT.test(text) || /severe/i.test(severity) || /week|[2-9]\s*weeks|month/i.test(duration)) urgency = 'urgent';
  else if ((MILD.test(text) || /mild/i.test(severity)) && /^(general|ent)/i.test(top.specialty)) urgency = 'self-care';
  const doctors = await rankDoctors(top.specialty);
  return {
    urgency, safety, specialty: top.specialty, possible: top.possible, selfCare: top.care, questions: top.ask, doctors,
    summary: `${urgencyLabel(urgency)} · suggested specialty: ${top.specialty}`,
    disclaimer: 'This is general guidance, not a diagnosis. A qualified doctor should confirm any condition.'
  };
}
export const urgencyLabel = u => ({ emergency: 'Emergency — seek care now', urgent: 'Needs prompt attention (within 24 hours)', routine: 'Routine — book a consultation', 'self-care': 'Likely manageable at home — monitor' }[u]);

export async function rankDoctors(specialty, limit = 3) {
  const docs = await all(`SELECT d.*, u.name, u.photo, u.gender FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.status='approved' ${specialty ? 'AND d.specialty=?' : ''} ORDER BY d.rating DESC, d.reviews_count DESC LIMIT ?`, specialty ? [specialty, limit] : [limit]);
  return Promise.all(docs.map(async d => ({ id: d.id, name: d.name, photo: d.photo, gender: d.gender, specialty: d.specialty, rating: d.rating, fee: d.fee, color: d.color, experience: d.experience, next: await nextSlot(d) })));
}
export async function slotsForDate(doc, date) {
  const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00`).getDay()];
  const sched = JSON.parse(doc.schedule || '{}'); const leave = JSON.parse(doc.leave_dates || '[]');
  if (leave.includes(date) || !sched[wd]) return [];
  const taken = new Set(await all("SELECT time FROM appointments WHERE doctor_id=? AND date=? AND status NOT IN ('cancelled')", [doc.id, date]).map(r => r.time));
  const now = new Date(); const isToday = date === ymd(now); const nowMin = now.getHours() * 60 + now.getMinutes() + 30;
  const out = [];
  for (const [a, b] of sched[wd]) {
    let [h, m] = a.split(':').map(Number); const [eh, em] = b.split(':').map(Number);
    for (let t = h * 60 + m; t + doc.slot_minutes <= eh * 60 + em; t += doc.slot_minutes) {
      const label = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      if (taken.has(label) || (isToday && t < nowMin)) continue;
      out.push(label);
    }
  }
  return out;
}
export async function nextSlot(doc) {
  for (let i = 0; i < 14; i++) { const date = ymd(addDays(new Date(), i)); const s = await slotsForDate(doc, date); if (s.length) return { date, time: s[0] }; }
  return null;
}

/* ---------------------------------------------------------------- patient assistant */
const FAQ = [
  [/fever|temperature/, 'For an adult, a fever is usually 38 °C (100.4 °F) or above. Rest, drink plenty of fluids, and paracetamol can help if your doctor has said it is safe for you. See a doctor if fever lasts more than 3 days, goes above 39.5 °C (103 °F), or comes with a stiff neck, rash, confusion or breathing trouble. For babies under 3 months, any fever needs urgent medical review.'],
  [/headache|migraine/, 'Most headaches are tension-type and ease with rest, water, regular meals and reduced screen time. Seek urgent care for a sudden "worst ever" headache, headache after a head injury, or one with weakness, vision changes or confusion. If headaches are frequent, a doctor can help find the pattern.'],
  [/blood pressure|\bbp\b|hypertension/, 'Normal adult blood pressure is generally below 120/80 mmHg. Readings repeatedly at or above 140/90 deserve a doctor\'s review. Measure seated, after 5 minutes of rest, at the same time each day, and log it in your Health tracker so your doctor can see the trend.'],
  [/diabet|blood sugar|glucose/, 'A normal fasting blood sugar is typically 70–99 mg/dL; 100–125 suggests pre-diabetes and 126 or more on two tests suggests diabetes. Balanced meals, daily walking and regular check-ups help a lot. Your doctor can personalise targets for you.'],
  [/sleep|insomnia/, 'For better sleep: keep a fixed bedtime, avoid caffeine after mid-afternoon, dim lights and screens an hour before bed, and keep the room cool and dark. If poor sleep lasts more than 3 weeks or affects daytime function, consider speaking with a doctor.'],
  [/stress|anxiety|anxious/, 'Brief practices help: slow breathing (in 4s, out 6s), a 10-minute walk, writing worries down, and limiting caffeine. If anxiety is constant or interfering with life, a conversation with one of our mental wellness doctors can really help.'],
  [/diet|nutrition|weight|healthy eating/, 'A simple pattern works for most people: half the plate vegetables and fruit, a quarter protein, a quarter whole grains, water as the main drink, and less sugar, salt and ultra-processed food. A doctor or dietitian can tailor advice to any conditions you have.'],
  [/cold|cough|flu|sore throat/, 'Most colds are viral and settle in 7–10 days. Rest, fluids, warm saline gargles and steam help. See a doctor if there is breathlessness, fever beyond 3 days, wheeze, or a cough lasting more than 3 weeks.'],
  [/exercise|workout|fitness/, 'Adults benefit from about 150 minutes of moderate activity a week (for example brisk walking) plus muscle-strengthening twice a week. Start small and build up; check with your doctor first if you have a heart condition or other health concerns.'],
  [/covid|vaccin/, 'Vaccination schedules depend on age and health conditions. A doctor can advise which vaccines you or your family are due for. You can book a quick general medicine or pediatrics consultation for this.']
];

export async function patientChat({ messages = [], user }) {
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const safety = safetyCheck(last);
  if (safety) return { reply: emergencyReply(safety), urgency: 'emergency', source: 'safety', actions: safety.level === 'crisis' ? [{ type: 'link', label: 'Talk to a mental wellness doctor', to: '/doctors?specialty=Mental%20Wellness' }] : [{ type: 'link', label: 'Find a doctor after you are safe', to: '/doctors' }] };

  const mine = await all("SELECT a.*, u.name doctor_name, d.specialty FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users u ON u.id=d.user_id WHERE a.user_id=? AND a.status='confirmed' AND a.date>=? ORDER BY a.date,a.time LIMIT 3", [user.id, ymd()]);
  const t = await triage({ text: messages.filter(m => m.role === 'user').map(m => m.content).join('. ') });
  const lower = last.toLowerCase();

  // Optional LLM path
  if (llmEnabled()) {
    const ranked = await rankDoctors(null, 8); const docs = ranked.map(d => `${d.name} (${d.specialty}, ₹${d.fee}, rating ${d.rating})`).join('; ');
    const system = `You are Vita, the friendly health assistant of the HealthSync online consultation platform. Patient: ${user.name}. Upcoming appointments: ${mine.map(a => `${a.doctor_name} on ${a.date} ${a.time}`).join('; ') || 'none'}. Available doctors: ${docs}.\nRules: give general health information only, never a diagnosis or prescription dosage; be warm, concise (under 150 words), plain language; ask at most one follow-up question; suggest the right specialty and booking a doctor when symptoms need evaluation; for anything that could be an emergency tell them to call ${EMERGENCY} immediately.`;
    const out = await callClaude({ system, messages: messages.slice(-10).map(m => ({ role: m.role, content: m.content })) });
    if (out) return { reply: out, urgency: t.urgency, source: 'claude', actions: bookingActions(t, lower) };
  }

  // Built-in engine
  if (/^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b/.test(lower.trim()) && lower.length < 40)
    return { reply: `Hello ${user.name.split(' ')[0]}! I'm Vita. I can check symptoms, suggest the right specialist, find the earliest slot, explain your prescriptions, or answer everyday health questions. What's on your mind?`, source: 'built-in', actions: [{ type: 'link', label: 'Check my symptoms', to: '/patient/assistant?mode=symptoms' }, { type: 'link', label: 'Find a doctor', to: '/doctors' }] };
  if (/my (appointments?|bookings?|schedule)|upcoming/.test(lower))
    return { reply: mine.length ? `You have ${mine.length} upcoming appointment${mine.length > 1 ? 's' : ''}:\n${mine.map(a => `• ${a.doctor_name} (${a.specialty}) — ${a.date} at ${a.time}, ${a.mode}`).join('\n')}` : "You don't have any upcoming appointments yet. Would you like me to find a doctor for you?", source: 'built-in', actions: [{ type: 'link', label: 'Open my appointments', to: '/patient/appointments' }] };
  if (/prescription|medicine|tablet/.test(lower) && /(my|last|latest|show|what)/.test(lower)) {
    const rx = await get('SELECT p.*, u.name doctor_name FROM prescriptions p JOIN doctors d ON d.id=p.doctor_id JOIN users u ON u.id=d.user_id WHERE p.user_id=? ORDER BY p.issued_at DESC, p.id DESC LIMIT 1', [user.id]);
    if (rx) { const meds = JSON.parse(rx.medicines || '[]'); return { reply: `Your latest prescription is from ${rx.doctor_name}:\n${meds.map(m => `• ${m.name} — ${m.dose}, ${m.frequency}${m.days ? ` for ${m.days} days` : ''}`).join('\n')}\n\nAlways follow your doctor's instructions, and message them if you have side effects.`, source: 'built-in', actions: [{ type: 'link', label: 'View all prescriptions', to: '/patient/records?tab=prescriptions' }] }; }
    return { reply: "I couldn't find a prescription on your account yet. Prescriptions appear here after a doctor issues one during or after your consultation.", source: 'built-in', actions: [] };
  }
  if (/cancel|reschedule|change (my )?(appointment|slot)/.test(lower))
    return { reply: 'You can cancel or reschedule from My appointments — free of charge up to a few hours before the visit (the exact window is shown on the booking). I can take you there.', source: 'built-in', actions: [{ type: 'link', label: 'Manage appointments', to: '/patient/appointments' }] };
  if (/upload|report|lab result|scan/.test(lower) && /(how|where|can i|upload)/.test(lower))
    return { reply: 'Go to Records → Upload report, choose a PDF or image (up to 8 MB), and give it a label. Doctors you have booked can see your reports during the consultation.', source: 'built-in', actions: [{ type: 'link', label: 'Open Records', to: '/patient/records' }] };
  if (/fee|price|cost|how much|charge|coupon|discount/.test(lower))
    return { reply: `Consultation fees are set by each doctor and shown on their profile, plus a small platform fee at checkout. Coupons such as WELCOME10 can be applied on the payment step.`, source: 'built-in', actions: [{ type: 'link', label: 'Compare doctors', to: '/doctors' }] };
  if (/(book|appointment|consult|see a doctor|find (me )?a doctor|available|earliest|slot)/.test(lower)) {
    const spec = triageSpecialtyFromText(lower) || t.specialty; const docs = await rankDoctors(spec);
    return { reply: docs.length ? `Here are top-rated ${spec} doctors with their earliest availability. Tap a doctor to pick a time.` : `I couldn't find a ${spec} doctor right now. Try browsing all doctors.`, source: 'built-in', actions: docs.map(d => ({ type: 'doctor', doctor: d })), urgency: t.urgency };
  }
  const faq = FAQ.find(([re]) => re.test(lower));
  const hasSymptomWords = CLUSTERS.some(c => c.words.some(w => ` ${lower} `.includes(w)));
  if (hasSymptomWords || /feel|pain|hurt|symptom|sick|unwell|ache/.test(lower)) {
    const body = `Thanks for sharing that. Based on what you've told me, ${t.urgency === 'urgent' ? 'this deserves prompt medical attention (ideally within 24 hours).' : t.urgency === 'self-care' ? 'this sounds like something that can often be managed at home while you monitor it.' : 'a consultation would be a sensible next step.'}\n\n**Things that could be behind this** (not a diagnosis):\n${t.possible.map(p => `• ${p}`).join('\n')}\n\n**What may help now:**\n${t.selfCare.map(p => `• ${p}`).join('\n')}\n\nSuggested specialty: **${t.specialty}**.\n\nTo narrow this down: ${t.questions[0]}`;
    return { reply: body, source: 'built-in', urgency: t.urgency, actions: t.doctors.slice(0, 2).map(d => ({ type: 'doctor', doctor: d })) };
  }
  if (faq) return { reply: faq[1], source: 'built-in', actions: [] };
  return { reply: "I can help with symptom guidance, finding the right doctor, booking, your prescriptions and everyday health questions. Try something like \"I have had a fever for two days\" or \"book a dermatologist\".", source: 'built-in', actions: [{ type: 'link', label: 'Check my symptoms', to: '/patient/assistant?mode=symptoms' }] };
}
function triageSpecialtyFromText(lower) {
  const m = { cardiolog: 'Cardiology', heart: 'Cardiology', dermatolog: 'Dermatology', skin: 'Dermatology', psychiat: 'Mental Wellness', therap: 'Mental Wellness', mental: 'Mental Wellness', pediatric: 'Pediatrics', child: 'Pediatrics', orthop: 'Orthopedics', bone: 'Orthopedics', gynec: 'Gynecology', ent: 'ENT', 'general physician': 'General Medicine', 'general medicine': 'General Medicine' };
  for (const k of Object.keys(m)) if (new RegExp(`\\b${k}`).test(lower)) return m[k];
  return null;
}
function bookingActions(t, lower) { return /(book|appointment|doctor)/.test(lower) || t.urgency !== 'self-care' ? t.doctors.slice(0, 2).map(d => ({ type: 'doctor', doctor: d })) : []; }

/* ---------------------------------------------------------------- doctor tools */
export async function soapFromNotes({ notes = '', appointment, patient }) {
  if (llmEnabled()) {
    const out = await callClaude({ max_tokens: 700, system: 'You are a clinical documentation assistant for a licensed doctor. Convert rough consultation notes into a concise SOAP note. Return ONLY valid JSON: {"s":"","o":"","a":"","p":""}. Do not invent findings that are not in the notes; write "Not documented" when missing.', messages: [{ role: 'user', content: `Reason for visit: ${appointment?.reason || ''}\nPatient: ${patient?.name || ''}, allergies: ${patient?.allergies || 'none recorded'}, conditions: ${patient?.conditions || 'none recorded'}\nNotes:\n${notes}` }] });
    try { const j = JSON.parse(out.replace(/```json|```/g, '').trim()); if (j.s) return { ...j, source: 'claude' }; } catch { /* fall through */ }
  }
  const lines = notes.split(/\n|\. /).map(s => s.trim()).filter(Boolean);
  const bucket = { s: [], o: [], a: [], p: [] };
  for (const l of lines) {
    if (/^(dx|diagnos|impression|assessment|a:|likely|probable|suspect)/i.test(l)) bucket.a.push(l.replace(/^(dx|a):?\s*/i, ''));
    else if (/^(plan|rx|advise|advice|start|continue|review|follow|refer|order|investigat|p:)|\b(prescrib|advised|follow[- ]?up|review in|recommend)/i.test(l)) bucket.p.push(l.replace(/^p:\s*/i, ''));
    else if (/\b(bp|pulse|temp|spo2|o2|exam|auscult|vitals|rr|bmi|weight|on examination|o\/e|o:)\b|\d+\/\d+|mmhg|bpm/i.test(l)) bucket.o.push(l.replace(/^o:\s*/i, ''));
    else bucket.s.push(l.replace(/^s:\s*/i, ''));
  }
  const j = k => bucket[k].join('. ') || 'Not documented';
  return { s: bucket.s.length ? j('s') : (appointment?.reason || 'Not documented'), o: j('o'), a: j('a'), p: j('p'), source: 'built-in' };
}

const FORMULARY = [
  [/viral|urti|cold|rhinitis|fever|flu/, [{ name: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'Every 6–8 hours if fever/pain (max 4 per day)', days: 3 }, { name: 'Cetirizine 10 mg', dose: '1 tablet', frequency: 'At bedtime', days: 5 }, { name: 'Saline nasal spray', dose: '2 sprays/nostril', frequency: 'Three times daily', days: 5 }]],
  [/hypertension|high blood pressure/, [{ name: 'Amlodipine 5 mg', dose: '1 tablet', frequency: 'Once daily, morning', days: 30 }]],
  [/gastritis|acidity|reflux|gerd|dyspepsia/, [{ name: 'Pantoprazole 40 mg', dose: '1 tablet', frequency: 'Once daily, before breakfast', days: 14 }, { name: 'Antacid gel', dose: '10 ml', frequency: 'After meals and at bedtime if needed', days: 7 }]],
  [/headache|migraine|tension/, [{ name: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'When required (max 4 per day)', days: 3 }]],
  [/allerg|dermatitis|urticaria|itch/, [{ name: 'Cetirizine 10 mg', dose: '1 tablet', frequency: 'At bedtime', days: 7 }, { name: 'Calamine lotion', dose: 'Apply thinly', frequency: 'Twice daily to affected area', days: 7 }]],
  [/vitamin d|deficiency/, [{ name: 'Vitamin D3 60,000 IU', dose: '1 capsule', frequency: 'Once weekly', days: 56 }]],
  [/diarrh|gastroenteritis|loose/, [{ name: 'ORS sachet', dose: '1 sachet in 1 L water', frequency: 'Sip through the day', days: 3 }, { name: 'Zinc 20 mg', dose: '1 tablet', frequency: 'Once daily', days: 10 }]],
  [/anxiety|stress/, [{ name: 'Lifestyle & CBT measures', dose: '—', frequency: 'Breathing exercises, sleep routine, daily walk', days: 14 }]]
];
export function suggestRx({ diagnosis = '', allergies = '' }) {
  const hit = FORMULARY.find(([re]) => re.test(diagnosis.toLowerCase()));
  const meds = hit ? hit[1] : [];
  const al = allergies.toLowerCase();
  const warnings = [];
  const checked = meds.map(m => { const key = m.name.split(' ')[0].toLowerCase(); const conflict = al && (al.includes(key) || (al.includes('penicillin') && /amoxi|ampi|penicillin/.test(key)) || (al.includes('sulfa') && /sulfa|cotrim/.test(key))); if (conflict) warnings.push(`Patient allergy (${allergies}) may conflict with ${m.name}`); return m; });
  return { medicines: checked, warnings, note: 'AI suggestions are a starting point for a licensed clinician to review. Verify drug, dose, allergies and interactions before issuing.' };
}

export async function patientBrief(patientId, doctorId) {
  const p = await get('SELECT * FROM users WHERE id=?', [patientId]);
  const visits = await all("SELECT a.*, u.name doctor_name FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users u ON u.id=d.user_id WHERE a.user_id=? AND a.status='completed' ORDER BY a.date DESC LIMIT 5", [patientId]);
  const rx = await all('SELECT * FROM prescriptions WHERE user_id=? ORDER BY issued_at DESC LIMIT 3', [patientId]);
  const bp = await all("SELECT * FROM vitals WHERE user_id=? AND kind='bp' ORDER BY recorded_at DESC LIMIT 7", [patientId]);
  const reports = (await get('SELECT COUNT(*) c FROM reports WHERE user_id=?', [patientId])).c;
  const points = [];
  const age = p.dob ? Math.floor((Date.now() - new Date(p.dob)) / 31557600000) : null;
  points.push(`${p.name}${age ? `, ${age}` : ''}${p.gender ? `, ${p.gender}` : ''}${p.blood_group ? `, blood group ${p.blood_group}` : ''}.`);
  if (p.conditions) points.push(`Known conditions: ${p.conditions}.`);
  points.push(p.allergies ? `⚠ Allergies: ${p.allergies}.` : 'No allergies recorded.');
  if (visits.length) points.push(`${visits.length} recent completed visit${visits.length > 1 ? 's' : ''}; last: ${visits[0].date} with ${visits[0].doctor_name}${visits[0].diagnosis ? ` — ${visits[0].diagnosis}` : ''}.`);
  if (rx.length) points.push(`Latest prescription (${String(rx[0].issued_at).slice(0, 10)}): ${JSON.parse(rx[0].medicines || '[]').map(m => m.name).join(', ') || 'see record'}.`);
  if (bp.length) { const avgS = Math.round(bp.reduce((s, v) => s + v.value, 0) / bp.length), avgD = Math.round(bp.reduce((s, v) => s + (v.value2 || 0), 0) / bp.length); points.push(`Home BP average (last ${bp.length}): ${avgS}/${avgD} mmHg${avgS >= 140 || avgD >= 90 ? ' — above target' : ''}.`); }
  if (reports) points.push(`${reports} uploaded report${reports > 1 ? 's' : ''} available.`);
  return { points, source: 'built-in' };
}

/* ---------------------------------------------------------------- vitals interpretation */
export function interpretVital(kind, value, value2) {
  if (kind === 'bp') { if (value >= 180 || value2 >= 120) return { level: 'danger', text: 'Very high. Rest, recheck in 5 minutes, and seek urgent care if it stays high or you have symptoms.' }; if (value >= 140 || value2 >= 90) return { level: 'warn', text: 'High. Discuss with your doctor.' }; if (value >= 130 || value2 >= 80) return { level: 'warn', text: 'Slightly elevated.' }; if (value < 90 || value2 < 60) return { level: 'warn', text: 'Low. Hydrate and rise slowly; see a doctor if dizzy.' }; return { level: 'ok', text: 'Healthy range.' }; }
  if (kind === 'glucose') { if (value >= 200) return { level: 'danger', text: 'High. Contact your doctor.' }; if (value >= 126) return { level: 'warn', text: 'Above fasting target.' }; if (value >= 100) return { level: 'warn', text: 'Slightly elevated.' }; if (value < 70) return { level: 'danger', text: 'Low. Take fast-acting sugar and seek help if unwell.' }; return { level: 'ok', text: 'Healthy range.' }; }
  if (kind === 'heart_rate') { if (value > 100) return { level: 'warn', text: 'Fast resting heart rate.' }; if (value < 50) return { level: 'warn', text: 'Slow heart rate.' }; return { level: 'ok', text: 'Normal resting range.' }; }
  return { level: 'ok', text: 'Logged.' };
}

/* ---------------------------------------------------------------- admin insights */
export async function adminInsights() {
  const today = ymd(); const d7 = ymd(addDays(new Date(), -7)); const d14 = ymd(addDays(new Date(), -14));
  const cnt = async (sql, p = []) => (await get(sql, p))?.c || 0;
  const insights = []; const actions = [];
  const w1 = await cnt("SELECT COUNT(*) c FROM appointments WHERE date>? AND date<=? AND status!='cancelled'", [d7, today]);
  const w0 = await cnt("SELECT COUNT(*) c FROM appointments WHERE date>? AND date<=? AND status!='cancelled'", [d14, d7]);
  if (w0) { const ch = Math.round(((w1 - w0) / w0) * 100); insights.push({ tone: ch >= 0 ? 'good' : 'warn', text: `Bookings ${ch >= 0 ? 'rose' : 'fell'} ${Math.abs(ch)}% versus the previous week (${w1} vs ${w0}).` }); }
  const done = await cnt("SELECT COUNT(*) c FROM appointments WHERE status='completed'"), ns = await cnt("SELECT COUNT(*) c FROM appointments WHERE status='no-show'"), can = await cnt("SELECT COUNT(*) c FROM appointments WHERE status='cancelled'"), total = await cnt('SELECT COUNT(*) c FROM appointments');
  if (total) { const nsr = Math.round((ns / total) * 100), cr = Math.round((can / total) * 100); insights.push({ tone: nsr > 6 ? 'warn' : 'good', text: `No-show rate is ${nsr}% and cancellation rate is ${cr}%.` }); if (nsr > 6) actions.push('Enable SMS/WhatsApp reminders 2 hours before each visit to reduce no-shows.'); }
  const topSpec = await get("SELECT d.specialty s, COUNT(*) c FROM appointments a JOIN doctors d ON d.id=a.doctor_id WHERE a.status!='cancelled' GROUP BY d.specialty ORDER BY c DESC LIMIT 1");
  if (topSpec) insights.push({ tone: 'info', text: `${topSpec.s} is the most booked specialty (${topSpec.c} visits).` });
  const low = await all("SELECT u.name, d.rating FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.status='approved' AND d.reviews_count>=3 AND d.rating<4.3");
  low.forEach(d => { insights.push({ tone: 'warn', text: `${d.name} has a ${d.rating} rating — consider a quality review.` }); });
  const pending = await cnt("SELECT COUNT(*) c FROM doctors WHERE status='pending'");
  if (pending) { insights.push({ tone: 'warn', text: `${pending} doctor application${pending > 1 ? 's are' : ' is'} waiting for approval.` }); actions.push('Review pending doctor applications to grow capacity.'); }
  const unpaid = await cnt("SELECT COUNT(*) c FROM appointments WHERE payment_status='pending' AND status IN ('confirmed','completed')");
  if (unpaid) { insights.push({ tone: 'info', text: `${unpaid} confirmed visits are marked "pay later".` }); }
  const load = await all("SELECT u.name, COUNT(*) c FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users u ON u.id=d.user_id WHERE a.date>=? AND a.date<=? AND a.status='confirmed' GROUP BY d.id, u.name ORDER BY c DESC", [today, ymd(addDays(new Date(), 7))]);
  if (load[0] && load[0].c >= 6) { insights.push({ tone: 'warn', text: `${load[0].name} has ${load[0].c} bookings in the next 7 days — capacity is tight.` }); actions.push('Ask busy doctors to open additional slots or add another doctor in the same specialty.'); }
  if (load.length < 4) actions.push('Several doctors have light schedules — promote them on the home page and with coupons.');
  const rev = await cnt("SELECT COALESCE(SUM(fee+platform_fee-discount),0) c FROM appointments WHERE payment_status='paid' AND date>?", [d7]);
  insights.push({ tone: 'info', text: `Paid revenue in the last 7 days: ₹${rev.toLocaleString('en-IN')}.` });
  // simple 7-day forecast: average of last 14 days of created bookings by date
  const hist = await all("SELECT date, COUNT(*) c FROM appointments WHERE date>? AND date<=? AND status!='cancelled' GROUP BY date", [d14, today]);
  const forecast = hist.length ? Math.round((hist.reduce((s, h) => s + h.c, 0) / 14) * 7) : 0;
  insights.push({ tone: 'info', text: `Forecast: roughly ${forecast} bookings expected over the next 7 days at current pace.` });
  void done;
  return { insights, actions, forecast, source: 'built-in' };
}

export async function adminAsk(question, snapshot) {
  if (llmEnabled()) {
    const out = await callClaude({ system: 'You are an analytics assistant for the admin of an online doctor-consultation platform. Answer using ONLY the JSON snapshot provided. Be concise (under 120 words) and specific with numbers; suggest one actionable next step. If the data does not contain the answer, say so.', messages: [{ role: 'user', content: `Snapshot: ${JSON.stringify(snapshot)}\n\nQuestion: ${question}` }] });
    if (out) return { reply: out, source: 'claude' };
  }
  const q = question.toLowerCase();
  if (/revenue|money|earn/.test(q)) return { reply: `Paid revenue this month: ₹${snapshot.revenueMonth.toLocaleString('en-IN')}; last 30 days total bookings: ${snapshot.bookings30}.`, source: 'built-in' };
  if (/doctor|top|best/.test(q)) return { reply: `Top doctors by completed visits: ${snapshot.topDoctors.map(d => `${d.name} (${d.c})`).join(', ') || 'no data yet'}.`, source: 'built-in' };
  if (/pending|approv/.test(q)) return { reply: `${snapshot.pendingDoctors} doctor application(s) are pending approval.`, source: 'built-in' };
  if (/cancel|no.?show/.test(q)) return { reply: `Cancelled: ${snapshot.cancelled}, no-shows: ${snapshot.noShow} out of ${snapshot.total} appointments in total.`, source: 'built-in' };
  return { reply: `Platform snapshot: ${snapshot.total} appointments, ${snapshot.patients} patients, ${snapshot.doctors} active doctors. Ask about revenue, top doctors, cancellations or pending approvals for more detail.`, source: 'built-in' };
}
