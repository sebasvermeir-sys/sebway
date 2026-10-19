// Which Claude model answers a chat message. Plain rules, no AI.
// Haiku: short, first questions that are a single lookup ("next metro at Trône?"). About 20× cheaper.
// Sonnet: everything else (follow-ups, comparisons, strikes, planning). Also the fallback if Haiku fails.

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";

const MAX_SIMPLE_CHARS = 80;

/** Needs more reasoning than a single lookup. FR / NL / EN. */
const COMPLEX =
  /strike|grève|greve|staking|compare|vergelijk|compar|why|waarom|pourquoi|best|beste|meilleur|plan|commute|door to door|explain|uitleg|expliqu|alternative|alternatief|refund|terugbetal|rembours|should i|moet ik|dois-je/i;

/** Typical single lookups. */
const SIMPLE =
  /next|volgende|prochain|departure|vertrek|départ|depart|when|wanneer|quand|platform|perron|quai|delay|vertraging|retard|on time|op tijd|à l'heure|metro|tram|bus|train|trein/i;

export function pickModel(turns: { role: string; content: string }[]): string {
  if (turns.length !== 1) return SONNET;
  const q = turns[0].content.trim();
  if (q.length > MAX_SIMPLE_CHARS || COMPLEX.test(q)) return SONNET;
  return SIMPLE.test(q) ? HAIKU : SONNET;
}
