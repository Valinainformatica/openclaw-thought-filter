/**
 * Thought Filter Plugin for OpenClaw
 *
 * Intercepts outgoing WhatsApp messages via the `message_sending` plugin hook
 * and uses a scoring heuristic to detect "thinking out loud" — internal
 * reasoning that the agent accidentally writes as plain text.
 *
 * Instead of a blacklist of exact patterns (which the model easily evades),
 * this plugin accumulates weighted signals. If the total score exceeds a
 * threshold, the message is blocked or stripped.
 *
 * v2.0 — Scoring heuristic replaces regex blacklist approach
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ── Scoring threshold ───────────────────────────────────────────────────

const BLOCK_THRESHOLD = 50;

// ── Signal definitions ──────────────────────────────────────────────────

type Signal = {
  pattern: RegExp;
  score: number;
  label: string;
};

const SIGNALS: Signal[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // POSITIVE signals (indicators of internal thought)
  // ═══════════════════════════════════════════════════════════════════════

  // ── Direct thought starters (very strong) ──
  { pattern: /^(?:Voy a |Necesito |Tengo que |Debo )/i, score: 40, label: "monologue-start" },
  { pattern: /(?:No tengo contexto|Sin contexto|No reconozco|Me falta)/i, score: 45, label: "no-context" },
  { pattern: /(?:Sigue sin (?:tener )?sentido|No (?:me )?queda claro)/i, score: 40, label: "confusion" },
  { pattern: /^(?:Ahora (?:lo pillo|entiendo|veo|comprendo))/i, score: 40, label: "realization" },

  // ── Mentions boss/colleague by name (strong) ──
  { pattern: /(?:aviso|pregunto|consulto|digo|paso|notifico|informo) a (?:Efren|Jose|Efrén|José)/i, score: 40, label: "mentions-boss" },
  { pattern: /(?:Efren|Jose|Efrén|José) (?:está|estará|no está|anda|dice|dijo|me dijo|pregunta|pide|quiere)/i, score: 30, label: "references-boss" },
  { pattern: /(?:le (?:paso|pregunto|digo|comento) a (?:Efren|Jose))/i, score: 40, label: "action-toward-boss" },

  // ── References parts/orders by ID ──
  { pattern: /parte #?\d{3,}/i, score: 30, label: "part-id" },
  { pattern: /pedido #?\d{3,}/i, score: 30, label: "order-id" },

  // ── Third-person description of client (they're not talking TO the client) ──
  { pattern: /(?:no es cliente|es (?:un )?(?:tema|asunto) )/i, score: 30, label: "internal-classification" },
  { pattern: /(?:preguntando por|pregunta por|pide que le|solicita que)/i, score: 20, label: "third-person-narration" },
  { pattern: /(?:Dice que |dice que (?:viene|va|quiere|necesita|pasa|llama|trae))/i, score: 25, label: "relays-client-speech" },
  { pattern: /(?:que (?:estamos|estoy) (?:montando|reparando|arreglando|esperando|tramitando|gestionando|preparando))/i, score: 20, label: "work-in-progress" },

  // ── "Es [Name]," client identification (with optional phone/ID in parentheses) ──
  { pattern: /^Es [A-ZÁÉÍÓÚÑa-záéíóúñ][\wÁÉÍÓÚÑáéíóúñ\s()\d]{1,50},/i, score: 35, label: "client-identification" },

  // ── Internal vocabulary ──
  { pattern: /(?:comercial\/contable|tema (?:comercial|contable|administrativo|interno))/i, score: 25, label: "internal-vocab" },
  { pattern: /(?:fuera de (?:mi|su|nuestro) (?:competencia|alcance|ámbito))/i, score: 25, label: "scope-assessment" },
  { pattern: /(?:no (?:tengo|tiene) ficha|sin ficha|sin historial)/i, score: 35, label: "no-file" },
  { pattern: /(?:en (?:la|el) (?:BD|base de datos|sistema|CRM|ERP)|algún parte (?:abierto|pendiente|activo))/i, score: 20, label: "internal-system" },
  { pattern: /\(\d{6,}\)/i, score: 20, label: "phone-in-parens" },

  // ── Narrating what the client did/sent ──
  { pattern: /(?:me (?:manda|envía|pasa|escribe|reenvía) (?:foto|imagen|pdf|documento|audio|video|captura|mensaje))/i, score: 20, label: "narrating-receipt" },
  { pattern: /(?:[Vv]eo (?:el |la |un |una |que |los |las ))/i, score: 15, label: "narrating-observation" },

  // ── Describing schedule/context internally ──
  { pattern: /(?:como|ya que|porque) es horario (?:laboral|de cierre)/i, score: 25, label: "schedule-context" },
  { pattern: /estamos a las \d/i, score: 20, label: "time-reference" },
  { pattern: /(?:antes de (?:contestar|responder|decirle|hacer nada))/i, score: 25, label: "before-acting" },
  { pattern: /(?:fuera de horario|en horario laboral|en mi turno)/i, score: 20, label: "shift-reference" },

  // ── "Pero no me dice" / reasoning about ambiguity ──
  { pattern: /[Pp]ero no me dice/i, score: 30, label: "but-doesnt-say" },
  { pattern: /no me (?:queda claro|especifica|indica|dice) (?:qu[eé]|por|para|c[oó]mo|si)/i, score: 30, label: "unclear-intent" },

  // ── Narrating own actions ──
  { pattern: /(?:^|\. )(?:Busco|Miro|Compruebo|Verifico|Reviso|Ejecuto) /i, score: 20, label: "narrating-action" },
  { pattern: /(?:^|\. )(?:Buscando|Mirando|Comprobando|Verificando|Revisando|Ejecutando) /i, score: 20, label: "narrating-gerund" },

  // ── Planning connectors ──
  { pattern: /^(?:Le pregunto |Le voy a preguntar|Pregunto |Consulto )/i, score: 30, label: "planning-ask" },
  { pattern: /(?:Le pregunto (?:para|a ver|si|directamente)|Le confirmo|Le digo).*:$/i, score: 35, label: "trailing-thought" },

  // ── "Voy a [verb]" mid-sentence (planning action) ──
  { pattern: /(?:\.\s*|;\s*|–\s*|-\s*)Voy a (?:buscar|mirar|comprobar|verificar|revisar|preguntar|consultar)/i, score: 30, label: "mid-sentence-plan" },

  // ── Self-identification as AI/bot ──
  { pattern: /(?:soy (?:una? )?(?:IA|inteligencia artificial|bot|asistente virtual|chatbot))/i, score: 50, label: "reveals-ai" },
  { pattern: /(?:soy Claudia,? (?:la|el|del|una))/i, score: 15, label: "claudia-identity" },

  // ── English equivalents ──
  { pattern: /^(?:Let me |I'm going to |I need to |I don't have context)/i, score: 40, label: "english-monologue" },
  { pattern: /^(?:Looking for |Searching |Checking )/i, score: 30, label: "english-narration" },

  // ── Meta-commentary about what the client wants ──
  { pattern: /(?:quiere saber|está preguntando|me está pidiendo|lo que pide es)/i, score: 25, label: "meta-commentary" },

  // ═══════════════════════════════════════════════════════════════════════
  // NEGATIVE signals (indicators this IS a client-facing message)
  // ═══════════════════════════════════════════════════════════════════════

  // ── Greetings ──
  { pattern: /^(?:Buenas|Buenos? (?:d[ií]as|tardes|noches)|Hola|Muy buenas)/i, score: -50, label: "greeting" },

  // ── Direct address to the client ──
  { pattern: /\?/i, score: -15, label: "question-mark" },
  { pattern: /(?:^|\s)(?:te |tu |tú |ti )/i, score: -15, label: "direct-address-te" },
  { pattern: /(?:dime|cuéntame|necesitas|pásate|cuando quieras)/i, score: -20, label: "invitation" },

  // ── Short message (likely a quick reply) ──
  { pattern: /^.{1,25}$/i, score: -15, label: "short-message" },

  // ── Acknowledgements ──
  { pattern: /^(?:Ok|Vale|Dale|Sip|Perfecto|Pefecto|Genial|Entendido)/i, score: -40, label: "acknowledgement" },

  // ── Patience / hold messages ──
  { pattern: /^(?:Un momento|Dame un segundo|Ahora te |Espera un)/i, score: -40, label: "hold-message" },

  // ── Common client speech starters ──
  { pattern: /^Es que /i, score: -40, label: "es-que" },
  { pattern: /^Es verdad/i, score: -30, label: "es-verdad" },

  // ── Apologies to client ──
  { pattern: /^(?:Perdona que |Disculpa |Lo siento)/i, score: -30, label: "apology" },

  // ── Helpful content (prices, links, instructions) ──
  { pattern: /(?:https?:\/\/|www\.)/i, score: -20, label: "contains-url" },
  { pattern: /(?:\d+[.,]\d{2}\s*€|\d+\s*euros?)/i, score: -15, label: "contains-price" },
];

// ── Scoring engine ──────────────────────────────────────────────────────

function scoreMessage(content: string): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];

  for (const signal of SIGNALS) {
    if (signal.pattern.test(content)) {
      score += signal.score;
      matched.push(`${signal.label}(${signal.score > 0 ? "+" : ""}${signal.score})`);
    }
  }

  return { score, matched };
}

// ── Plugin definition ───────────────────────────────────────────────────

const plugin = {
  id: "thought-filter",
  name: "Thought Filter",
  description: "Filters out inner thoughts/reasoning from outgoing WhatsApp messages using scoring heuristic",

  register(api: OpenClawPluginApi) {
    api.on("message_sending", (event, ctx) => {
      // Only filter on client-facing channels (not admin/Telegram)
      if (ctx.channelId !== "whatsapp") return;

      const content = event.content;
      if (!content) return;

      const { score, matched } = scoreMessage(content);

      // Log scoring for debugging (always, even if not blocked)
      if (matched.length > 0) {
        api.logger.info(
          `[thought-filter] Score ${score}/${BLOCK_THRESHOLD} for message to ${event.to}: [${matched.join(", ")}]`
        );
      }

      // Block if score meets threshold
      if (score >= BLOCK_THRESHOLD) {
        api.logger.warn(
          `[thought-filter] BLOCKED message to ${event.to} (score ${score}): "${content.substring(0, 120)}..."`
        );
        return { cancel: true };
      }

      return;
    });

    api.logger.info(`[thought-filter] v2.0 loaded — scoring heuristic, threshold=${BLOCK_THRESHOLD}`);
  },
};

export default plugin;
