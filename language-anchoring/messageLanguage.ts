/**
 * Lightweight message-language detection (en / es).
 *
 * The default reply language was inferred only from the customer's phone
 * country code and the business's own setting - never from the message text.
 * A customer on a Spanish-country number (or writing to a Spanish-configured
 * business) who writes in English still got Spanish canned messages (PHI
 * redirect, escalations, portal fallback). This detector reads the message
 * itself and overrides the fallback when the text clearly leans one way.
 *
 * Word-boundary stopword scoring is deliberately simple: this only picks the
 * language for canned system messages and the AI prompt's default - the AI
 * itself still matches the customer's language on every reply.
 */

const ES_MARKERS = [
  'hola', 'buenos', 'buenas', 'gracias', 'por', 'para', 'que', 'qué', 'cómo',
  'como', 'cuándo', 'cuando', 'dónde', 'donde', 'cuánto', 'cuanto', 'quiero',
  'necesito', 'puede', 'puedes', 'podría', 'ayuda', 'ayudar', 'cita',
  'precio', 'precios', 'está', 'esta', 'este', 'hoy', 'mañana', 'tarde',
  'buen', 'bueno', 'buena', 'pero', 'muy', 'más', 'mas', 'usted', 'tengo',
  'tiene', 'somos', 'soy', 'eres', 'hacer', 'servicio', 'días', 'dias',
  'semana', 'disculpe', 'perdón', 'perdon', 'cuántos', 'cuantos', 'dime',
  'saludos', 'señor', 'señora',
];

const EN_MARKERS = [
  'the', 'and', 'you', 'your', 'how', 'what', 'when', 'where', 'can', 'could',
  'would', 'my', 'me', 'is', 'are', 'do', 'does', 'did', 'hi', 'hello', 'hey',
  'thanks', 'thank', 'please', 'want', 'need', 'help', 'book', 'booking',
  'appointment', 'price', 'prices', 'today', 'tomorrow', 'yes', 'but', 'more',
  'have', 'has', 'this', 'that', 'with', 'for', 'about', 'there', 'here',
  'good', 'morning', 'afternoon', 'evening', 'question', 'service', 'available',
];

// Words that appear in both lists or are too ambiguous to count.
const AMBIGUOUS = new Set(['no', 'sí', 'si', 'ok', 'ok!', 'bien', 'well', 'fine']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Confident-only variant: 'en'/'es' when the text clearly leans one way,
 * null when it is too short or ambiguous ("Yes", "Ok", "Sorry"). Callers
 * that must not mislabel an ambiguous message (the AI prompt's language
 * anchor) use this and pick their own fallback; canned-message callers
 * keep detectMessageLanguage's phone/business fallback.
 */
export function detectMessageLanguageStrict(text: string | undefined): string | null {
  if (!text || text.trim().length < 3) return null;
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  let esScore = 0;
  let enScore = 0;
  for (const tok of tokens) {
    if (AMBIGUOUS.has(tok)) continue;
    if (ES_MARKERS.includes(tok)) esScore += 1;
    if (EN_MARKERS.includes(tok)) enScore += 1;
  }

  // Require a clear lean. Two markers, or a single marker when nothing
  // contradicts it (a bare "Hello" / "Hola" greeting is still a signal).
  if (esScore > 0 && esScore >= 2 - (enScore === 0 ? 1 : 0) && esScore > enScore) return 'es';
  if (enScore > 0 && enScore >= 2 - (esScore === 0 ? 1 : 0) && enScore > esScore) return 'en';
  return null;
}

export function detectMessageLanguage(text: string | undefined, fallback: string): string {
  return detectMessageLanguageStrict(text) ?? fallback;
}