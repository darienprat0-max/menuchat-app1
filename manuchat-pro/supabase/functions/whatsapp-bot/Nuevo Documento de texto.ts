import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const VERIFY_TOKEN = Deno.env.get("WA_VERIFY_TOKEN")!;
const DEFAULT_WA_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const money = (n: number) => `$${Number(n || 0).toFixed(2)}`;

async function sendWhatsApp(phoneId: string, token: string, to: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
  });
  if (!res.ok) {
    console.error("Meta API Error:", await res.text());
  }
}

function sendText(phoneId: string, token: string, to: string, body: string) {
  return sendWhatsApp(phoneId, token, to, { type: "text", text: { body } });
}

function sendButtons(
  phoneId: string,
  token: string,
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
) {
  return sendWhatsApp(phoneId, token, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

serve(async (req) => {
  const url = new URL(req.url);

  // 1. Verificación inicial del Webhook por Meta (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // 2. Mensajes entrantes de WhatsApp (POST)
  const body = await req.json();
  const entry = body.entry?.[0]?.changes?.[0]?.value;
  const msg = entry?.messages?.[0];
  const phoneId = entry?.metadata?.phone_number_id;

  if (!msg || !phoneId) return new Response("OK", { status: 200 });

  const from = msg.from; // Ej. 5216691234567
  const profileName = entry?.contacts?.[0]?.profile?.name || "Cliente";
  const userInput =
    msg.type === "text"
      ? msg.text.body.trim()
      : msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";

  // Enrutamiento Multi-Restaurante por phone_number_id
  const { data: rest } = await sb
    .from("restaurantes")
    .select("*")
    .eq("whatsapp_phone_id", phoneId)
    .maybeSingle();

  if (!rest) {
    console.warn("Phone ID sin restaurante asociado:", phoneId);
    return new Response("OK", { status: 200 });
  }

  // Usa el token propio del restaurante si tiene uno, o el token maestro de tu App Meta
  const activeToken = rest.whatsapp_token || DEFAULT_WA_TOKEN;
  const shipCost = Number(rest.costo_envio) || 0;
  const minOrder = Number(rest.pedido_minimo) || 0;

  // Buscar sesión activa para (telefono + restaurante_id)
  let { data: sesion } = await sb
    .from("bot_sesiones")
    .select("*")
    .eq("telefono", from)
    .eq("restaurante_id", rest.id)
    .maybeSingle();

  const lower = userInput.toLowerCase();
  if (!sesion || lower === "hola" || lower === "menu" || lower === "menú" || lower === "reiniciar") {
    // Detectar si es cliente recurrente en este restaurante
    const { data: clientePrev } = await sb.rpc("buscar_cliente_bot", {
      p_restaurante_id: rest.id,
      p_telefono: from,
    });
    const recurrente = clientePrev?.[0] || null;

    sesion = {
      telefono: from,
      restaurante_id: rest.id,
      step: "ordenando",
      datos: {
        cart: [],
        cliente: recurrente?.nombre || profileName,
        esRecurrente: Boolean(recurrente?.nombre),
        direccionGuardada: recurrente?.direccion || "",
      },
    };
    await sb.from("bot_sesiones").upsert(sesion);

    const { data: menu } = await sb
      .from("productos")
      .select("id, nombre, precio, categoria")
      .eq("restaurante_id", rest.id)
      .eq("activo", true)
      .order("categoria", { ascending: true });

    const listaMenu = (menu || [])
      .map((p, i) => `*${i + 1}.* ${p.nombre} — *${money(p.precio)}*`)
      .join("\n");

    const saludo = recurrente?.nombre
      ? `¡Hola de nuevo, *${recurrente.nombre}*! 👋 Qué gusto verte otra vez en *${rest.nombre}*.`
      : `¡Hola! 👋 Bienvenido a *${rest.nombre}*.`;

    await sendText(
      phoneId,
      activeToken,
      from,
      `${saludo}\n\n📋 *Menú disponible hoy:*\n${listaMenu || "_Sin platillos activos_"}\n\n✍️ Escribe el número o nombre de tus platillos (ej: _2 Taco Gobernador, 1 Agua de Cebada_)`
    );
    return new Response("OK", { status: 200 });
  }

  const datos = sesion.datos || {};

  // PASO 1: SELECCIÓN DE PLATILLOS
  if (sesion.step === "ordenando") {
    if (userInput === "btn_continuar") {
      const subtotal = (datos.cart || []).reduce((s: number, i: any) => s + i.precio * i.qty, 0);
      if (subtotal <= 0) {
        await sendText(phoneId, activeToken, from, "Aún no agregas platillos. Escribe qué deseas ordenar.");
        return new Response("OK", { status: 200 });
      }
      if (minOrder > 0 && subtotal < minOrder) {
        await sendText(
          phoneId,
          activeToken,
          from,
          `⚠️ El pedido mínimo en *${rest.nombre}* es de *${money(minOrder)} MXN* y llevas *${money(subtotal)} MXN*. Agrega algo más para continuar.`
        );
        return new Response("OK", { status: 200 });
      }

      sesion.step = "modalidad";
      await sb.from("bot_sesiones").upsert(sesion);

      const opciones = [];
      if (rest.acepta_domicilio !== false) opciones.push({ id: "mod_domicilio", title: "🛵 A domicilio" });
      opciones.push({ id: "mod_recoger", title: "🛍️ Para recoger" });
      opciones.push({ id: "mod_mesa", title: "🍽️ En restaurante" });

      await sendButtons(
        phoneId,
        activeToken,
        from,
        `¿Cómo deseas recibir tu pedido?${
          rest.acepta_domicilio !== false
            ? shipCost > 0
              ? `\n🛵 _Servicio a domicilio: ${money(shipCost)} MXN_`
              : `\n🛵 _¡Envío a domicilio gratis!_`
            : ""
        }`,
        opciones
      );
      return new Response("OK", { status: 200 });
    }

    const { data: menu } = await sb
      .from("productos")
      .select("*")
      .eq("restaurante_id", rest.id)
      .eq("activo", true)
      .order("categoria", { ascending: true });

    const partes = lower.split(/,|\by\b|\+/);
    const agregados: string[] = [];

    for (const p of partes) {
      const clean = p.trim();
      if (!clean) continue;
      const m = clean.match(/^(\d+)\s*(?:x\s*)?(.*)$/);
      let qty = 1;
      let query = clean;

      // Soporta "2 taco gobernador" o el número de lista si escribe solo el índice
      if (m && m[2]) {
        qty = Math.max(1, parseInt(m[1], 10));
        query = m[2].trim();
      } else if (/^\d+$/.test(clean) && menu?.[parseInt(clean, 10) - 1]) {
        const byIndex = menu[parseInt(clean, 10) - 1];
        datos.cart.push({ nombre: byIndex.nombre, precio: Number(byIndex.precio), qty: 1 });
        agregados.push(`1x ${byIndex.nombre}`);
        continue;
      }

      const prod = (menu || []).find((item) => item.nombre.toLowerCase().includes(query) && query.length >= 3);
      if (prod) {
        datos.cart.push({ nombre: prod.nombre, precio: Number(prod.precio), qty });
        agregados.push(`${qty}x ${prod.nombre}`);
      }
    }

    if (agregados.length === 0) {
      await sendText(
        phoneId,
        activeToken,
        from,
        "No ubiqué ese platillo 😅. Escribe el nombre o el número de la lista del menú."
      );
      return new Response("OK", { status: 200 });
    }

    const subtotal = datos.cart.reduce((s: number, i: any) => s + i.precio * i.qty, 0);
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);

    await sendButtons(
      phoneId,
      activeToken,
      from,
      `✅ Agregado: *${agregados.join(", ")}*\n💵 Subtotal actual: *${money(subtotal)} MXN*\n\nEscribe más platillos o toca *Continuar pedido*:`,
      [{ id: "btn_continuar", title: "✅ Continuar pedido" }]
    );
    return new Response("OK", { status: 200 });
  }

  // PASO 2: MODALIDAD (CLIENTE NUEVO VS RECURRENTE)
  if (sesion.step === "modalidad") {
    if (userInput === "mod_domicilio") {
      datos.tipo = "Domicilio";
      if (datos.direccionGuardada) {
        sesion.step = "confirmar_dir";
        sesion.datos = datos;
        await sb.from("bot_sesiones").upsert(sesion);
        await sendButtons(
          phoneId,
          activeToken,
          from,
          `📍 Tenemos registrada tu dirección anterior:\n*${datos.direccionGuardada}*\n\n¿Entregamos en este mismo domicilio?`,
          [
            { id: "dir_misma", title: "✅ Sí, usar este" },
            { id: "dir_nueva", title: "📍 Nuevo domicilio" },
          ]
        );
      } else {
        sesion.step = datos.esRecurrente ? "pedir_calle" : "pedir_nombre";
        sesion.datos = datos;
        await sb.from("bot_sesiones").upsert(sesion);
        await sendText(
          phoneId,
          activeToken,
          from,
          datos.esRecurrente
            ? "🛵 Escribe tu *Calle y número* para la entrega:"
            : "🆕 Como es tu primera orden, ¿cuál es tu *Nombre completo*?"
        );
      }
    } else {
      datos.tipo = userInput === "mod_mesa" ? "Comer en restaurante" : "Recoger";
      datos.direccion = datos.tipo === "Comer en restaurante" ? "Mesa por asignar" : "Recoger en sucursal";
      if (!datos.esRecurrente) {
        sesion.step = "pedir_nombre_local";
        sesion.datos = datos;
        await sb.from("bot_sesiones").upsert(sesion);
        await sendText(phoneId, activeToken, from, "🆕 ¿A qué *nombre* registramos tu orden?");
      } else {
        sesion.step = "pago";
        sesion.datos = datos;
        await sb.from("bot_sesiones").upsert(sesion);
        await sendButtons(phoneId, activeToken, from, "💳 ¿Cuál será tu *método de pago*?", [
          { id: "pago_efectivo", title: "💵 Efectivo" },
          { id: "pago_transferencia", title: "📲 Transferencia" },
          { id: "pago_terminal", title: "💳 Terminal" },
        ]);
      }
    }
    return new Response("OK", { status: 200 });
  }

  // PASO 3A: RECOLECCIÓN DE DATOS PARA CLIENTE INICIAL
  if (sesion.step === "pedir_nombre_local") {
    datos.cliente = userInput;
    sesion.step = "pago";
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);
    await sendButtons(phoneId, activeToken, from, "💳 ¿Cuál será tu *método de pago*?", [
      { id: "pago_efectivo", title: "💵 Efectivo" },
      { id: "pago_transferencia", title: "📲 Transferencia" },
      { id: "pago_terminal", title: "💳 Terminal" },
    ]);
    return new Response("OK", { status: 200 });
  }

  if (sesion.step === "pedir_nombre") {
    datos.cliente = userInput;
    sesion.step = "pedir_calle";
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);
    await sendText(phoneId, activeToken, from, "1️⃣ ¿Cuál es tu *Calle y número*?");
    return new Response("OK", { status: 200 });
  }

  if (sesion.step === "pedir_calle") {
    datos.calle = userInput;
    sesion.step = "pedir_colonia";
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);
    await sendText(phoneId, activeToken, from, "2️⃣ ¿Cuál es tu *Colonia o Fraccionamiento*?");
    return new Response("OK", { status: 200 });
  }

  if (sesion.step === "pedir_colonia") {
    datos.colonia = userInput;
    sesion.step = "pedir_ref";
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);
    await sendText(phoneId, activeToken, from, "3️⃣ ¿Alguna *referencia de fachada o entre calles* para el repartidor?");
    return new Response("OK", { status: 200 });
  }

  if (sesion.step === "pedir_ref") {
    datos.direccion = `${datos.calle}, Col. ${datos.colonia} (Ref: ${userInput})`;
    sesion.step = "pago";
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);
    await sendButtons(phoneId, activeToken, from, "💳 ¿Cuál será tu *método de pago*?", [
      { id: "pago_efectivo", title: "💵 Efectivo" },
      { id: "pago_transferencia", title: "📲 Transferencia" },
      { id: "pago_terminal", title: "💳 Terminal" },
    ]);
    return new Response("OK", { status: 200 });
  }

  // PASO 3B: CONFIRMACIÓN RÁPIDA DE DOMICILIO PARA CLIENTE RECURRENTE
  if (sesion.step === "confirmar_dir") {
    if (userInput === "dir_misma") {
      datos.direccion = datos.direccionGuardada;
      sesion.step = "pago";
      sesion.datos = datos;
      await sb.from("bot_sesiones").upsert(sesion);
      await sendButtons(phoneId, activeToken, from, "💳 ¿Cuál será tu *método de pago*?", [
        { id: "pago_efectivo", title: "💵 Efectivo" },
        { id: "pago_transferencia", title: "📲 Transferencia" },
        { id: "pago_terminal", title: "💳 Terminal" },
      ]);
    } else {
      sesion.step = "pedir_calle";
      await sb.from("bot_sesiones").upsert(sesion);
      await sendText(phoneId, activeToken, from, "📍 Escribe tu nueva *Calle y número*:");
    }
    return new Response("OK", { status: 200 });
  }

  // PASO 4: MÉTODO DE PAGO -> RESUMEN FINAL CON COBRO DE ENVÍO
  if (sesion.step === "pago") {
    datos.pago =
      userInput === "pago_transferencia"
        ? "Transferencia"
        : userInput === "pago_terminal"
        ? "Terminal"
        : "Efectivo";

    const subtotal = datos.cart.reduce((s: number, i: any) => s + i.precio * i.qty, 0);
    const envio = datos.tipo === "Domicilio" ? shipCost : 0;
    const totalFinal = subtotal + envio;
    const itemsTexto = datos.cart
      .map((i: any) => `${i.qty}x ${i.nombre} (${money(i.qty * i.precio)})`)
      .join(", ");

    datos.resumen = { subtotal, envio, totalFinal, itemsTexto };
    sesion.step = "confirmar_final";
    sesion.datos = datos;
    await sb.from("bot_sesiones").upsert(sesion);

    await sendButtons(
      phoneId,
      activeToken,
      from,
      `📋 *Confirma tu pedido y datos en ${rest.nombre}:*\n\n` +
        `• 👤 Cliente: *${datos.cliente}*\n` +
        `• 📦 Modalidad: *${datos.tipo}*\n` +
        (datos.tipo === "Domicilio" ? `• 📍 Domicilio: *${datos.direccion}*\n` : "") +
        `• 🌮 Pedido: ${itemsTexto}\n` +
        `• 💳 Método de pago: *${datos.pago}*\n` +
        `───────────────\n` +
        `• Subtotal platillos: *${money(subtotal)} MXN*\n` +
        (datos.tipo === "Domicilio" ? `• 🛵 Servicio a domicilio: *${money(envio)} MXN*\n` : "") +
        `• 💰 *TOTAL A PAGAR: ${money(totalFinal)} MXN*\n\n` +
        `¿Confirmas que tu pedido, domicilio y total son correctos?`,
      [
        { id: "confirmar_si", title: "✅ Confirmar pedido" },
        { id: "confirmar_no", title: "❌ Cancelar" },
      ]
    );
    return new Response("OK", { status: 200 });
  }

  // PASO 5: INSERCIÓN EN SUPABASE -> ENTRA AL PANEL EN VERCEL CON ALERTA SONORA
  if (sesion.step === "confirmar_final") {
    if (userInput === "confirmar_si") {
      const { totalFinal, itemsTexto, envio } = datos.resumen;
      const { data: orderId } = await sb.rpc("crear_pedido_bot", {
        p_restaurante_id: rest.id,
        p_cliente: datos.cliente,
        p_telefono: from.slice(-10),
        p_canal: "WhatsApp",
        p_tipo: datos.tipo,
        p_direccion: datos.direccion,
        p_items: envio > 0 ? `${itemsTexto}, 1x Servicio a domicilio (${money(envio)})` : itemsTexto,
        p_total: totalFinal,
        p_pago: datos.pago,
      });

      await sb.from("bot_sesiones").delete().eq("telefono", from).eq("restaurante_id", rest.id);

      await sendText(
        phoneId,
        activeToken,
        from,
        `🎉 *¡Pedido #${orderId} confirmado en ${rest.nombre}!*\n\n` +
          `• Total: *${money(totalFinal)} MXN*\n` +
          `• Ya entró directo a la cocina.\n` +
          `• Tus datos quedaron guardados para tu próxima orden.\n\n` +
          `Escribe *Hola* cuando quieras volver a ordenar.`
      );
    } else {
      await sb.from("bot_sesiones").delete().eq("telefono", from).eq("restaurante_id", rest.id);
      await sendText(phoneId, activeToken, from, "❌ Pedido cancelado. Escribe *Hola* para empezar de nuevo.");
    }
  }

  return new Response("OK", { status: 200 });
});