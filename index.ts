/**
 * Thought Filter Plugin for OpenClaw
 *
 * Intercepts outgoing WhatsApp messages via the `message_sending` plugin hook
 * and strips "thinking out loud" lines that the agent writes as plain text.
 *
 * These are NOT <thinking> blocks (those are already stripped by core).
 * These are lines like:
 *   "Es Adrian, el del USB para musica/DJ. Pero no tengo contexto de que es 'padre'."
 *   "Ahora lo pillo - quiere saber si su padre pasa por la tienda hoy."
 *   "Sigue sin tener sentido. Le pregunto directamente:"
 *   "Voy a buscar en la BD..."
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Thought-detection patterns ──────────────────────────────────────────

const THOUGHT_PATTERNS: RegExp[] = [
  // Spanish inner monologue starters
  /^(?:Voy a |Estoy |Necesito |Tengo que |Debo |Ahora (?:voy|tengo|necesito|busco|lo pillo|entiendo))/i,
  /^(?:No tengo contexto|Sin contexto|No reconozco|No s[eé] qui[eé]n|Me falta)/i,
  /^(?:Sigue sin (?:tener )?sentido|No (?:me )?queda claro|No entiendo)/i,
  /^(?:Le pregunto |Le voy a preguntar|Pregunto |Consulto )/i,
  /^(?:Buscando |Mirando |Comprobando |Verificando |Revisando )/i,
  /^(?:L[ií]nea a[ñn]adida|Relleno |Rellenando )/i,
  /^(?:Bloqueado|Eso no es correcto|Me llev[oó] a otro)/i,

  // "Es [Nombre], el/la del..." identification thoughts
  /^Es \w+,?\s+(?:el |la |del |de la |quien |que )/i,

  // Narrating own actions
  /(?:^|\. )(?:Voy a buscar|Ahora busco|Primero (?:busco|miro|compruebo|verifico))/i,
  /(?:^|\. )(?:Ejecuto|Ejecutando|Lanzo|Lanzando) /i,

  // Planning/reasoning connectors
  /^(?:Para (?:esto|ello|eso)|En (?:este caso|principio)|Seg[uú]n )/i,

  // English equivalents (fallback)
  /^(?:Let me |I'm going to |I need to |Looking for |Searching |I don't have context)/i,

  // Meta-commentary about the conversation
  /(?:quiere saber|est[aá] preguntando|me est[aá] pidiendo|lo que pide es)/i,

  // Trailing thought markers ending with ":"
  /(?:Le pregunto (?:para|a ver|si)|Le confirmo|Le digo|Le respondo).*:$/i,

  // Self-narrated corrections
  /^(?:Perdona|Corrijo|Me equivoqu[eé]|Error m[ií]o).*(?:en realidad|quer[ií]a decir|lo correcto es)/i,
];

// Lines that should NEVER be filtered (legitimate client replies)
const SAFE_PATTERNS: RegExp[] = [
  /^(?:Buenas|Buenos? (?:d[ií]as|tardes|noches)|Hola|Ok|Vale|Dale|Sip|Perfecto|Pefecto)/i,
  /^(?:Dime|Cu[eé]ntame|Qu[eé] (?:tal|necesitas|pasa)|C[oó]mo (?:puedo|te))/i,
  /^(?:Perdona que (?:estaba|no te|tard[eé])|Disculpa)/i,
  /^(?:Un momento|Dame un segundo|Ahora te (?:miro|digo|confirmo|aviso))/i,
];

function isThoughtLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  for (const safe of SAFE_PATTERNS) {
    if (safe.test(trimmed)) return false;
  }

  for (const pattern of THOUGHT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

function filterThoughts(content: string): { filtered: string; removed: string[] } {
  const lines = content.split("\n");
  const kept: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    if (isThoughtLine(line)) {
      removed.push(line);
    } else {
      kept.push(line);
    }
  }

  return {
    filtered: kept.join("\n").trim(),
    removed,
  };
}

// ── Plugin definition ───────────────────────────────────────────────────

const plugin = {
  id: "thought-filter",
  name: "Thought Filter",
  description: "Filters out inner thoughts/reasoning from outgoing WhatsApp messages",

  register(api: OpenClawPluginApi) {
    api.on("message_sending", (event, ctx) => {
      // Only filter on WhatsApp (Telegram is Efren - he sees everything)
      if (ctx.channelId !== "whatsapp") return;

      const original = event.content;
      if (!original) return;

      const { filtered, removed } = filterThoughts(original);

      if (removed.length > 0) {
        api.logger.warn(
          `[thought-filter] Stripped ${removed.length} thought line(s) from message to ${event.to}:\n` +
            removed.map((l) => `  - "${l}"`).join("\n")
        );
      }

      // If everything was filtered out, cancel the message entirely
      if (!filtered) {
        api.logger.warn(
          `[thought-filter] Entire message to ${event.to} was thoughts only. Cancelling send.`
        );
        return { cancel: true };
      }

      // If we removed something, return the cleaned content
      if (filtered !== original) {
        return { content: filtered };
      }

      // No changes
      return;
    });

    api.logger.info("[thought-filter] Loaded - monitoring outbound WhatsApp messages");
  },
};

export default plugin;
