/* ---------------------------------------------------------
 *  Bitrix migrador – tarefas + comentários + TAGS + MAPA ID
 *  grupo origem 27  ➜  grupo destino 5
 * --------------------------------------------------------*/
import express    from "express";
import axios      from "axios";
import fs         from "fs/promises";
import dotenv     from "dotenv";
import Bottleneck from "bottleneck";

dotenv.config();
const app  = express();
const PORT = process.env.PORT || 3000;

/* ---------- 1. mapa de etapas (27 → 5) ---------------- */
const stageMap = {
  615: 178,  // RECEBIDAS
  517: 180,  // REJEITADA
  529: 182,  // APROVADAS
  519: 188,  // ITENS DEFINIDOS
  533: 190,  // DOCUMENTAÇÃO
  609: 192,  // ESCLARECIMENTO | IMPUGNAÇÃO
  663: 194,  // DISPUTAR
  521: 196,  // GANHA
  607: 198,  // ANULAÇÃO | RECURSOS
  539: 200,  // HOMOLOGADA
  531: 202,  // EMPENHO
  537: 218,  // FATURADO
  523: 216,  // CANCELADA | SUSPENSA | REVOGADA
  527: 214,  // DESISTÊNCIA
  525: 212,  // PERDIDA
  543: 210,  // CATÁLOGO/ATESTADOS
  949: 206,  // ACESSO PORTAIS
  589: 208,  // CND (DOURADINA)
  591: 204   // CND (IPAMERI)
};

/* ---------- 2. axios origem / destino ---------------- */
const src = axios.create({
  baseURL: `${process.env.SRC_DOMAIN}/rest/${process.env.SRC_USER}/${process.env.SRC_TOKEN}/`,
  timeout: 20000
});
const dst = axios.create({
  baseURL: `${process.env.DST_DOMAIN}/rest/${process.env.DST_USER}/${process.env.DST_TOKEN}/`,
  timeout: 20000
});

/* ---------- 3. limitador (1 req/s) ------------------- */
const limiter     = new Bottleneck({ minTime: 1000, maxConcurrent: 1 });
const safeSrcGet  = (...args) => limiter.schedule(() => src.get (...args));
const safeDstPost = (...args) => limiter.schedule(() => dst.post(...args));
limiter.on("executing",
  () => console.log("➡️ REST", new Date().toLocaleTimeString()));

/* ---------- 4. arquivos de controle ------------------ */
const DONE_FILE = "./migrados.json";   // tarefas concluídas
const MAP_FILE  = "./idmap.json";      // { origem : destino }

let migrated = new Set();
let idmap    = {};
try { migrated = new Set(JSON.parse(await fs.readFile(DONE_FILE, "utf8"))); }
catch {}
try { idmap = JSON.parse(await fs.readFile(MAP_FILE, "utf8")); }
catch {}

/* ---------- 5. info extra (tags / mark) -------------- */
async function getTagsAndMark(taskId) {
  const { data } = await safeSrcGet("tasks.task.get", {
    params: { taskId, select: ["TAGS","SE_TAG","tags","MARK"] }
  });

  const t = data.result.task;
  let tags = [];
  if (t.TAGS?.length)        tags = t.TAGS;
  else if (t.SE_TAG?.length) tags = t.SE_TAG.map(o => o.NAME);
  else if (t.tags)           tags = Object.values(t.tags).map(o => o.title);

  return { tags, mark: t.MARK ?? null };
}

/* ---------- 6. criar tarefa destino ------------------ */
async function createTask(srcTask, tags, mark) {
  const payload = {
    fields: {
      TITLE        : srcTask.title,
      DESCRIPTION  : srcTask.description,
      STATUS       : Number(srcTask.status) || 1,
      GROUP_ID     : Number(process.env.DST_GROUP_ID),
      STAGE_ID     : stageMap[Number(srcTask.stageId)] || 178, // padrão RECEBIDAS

      RESPONSIBLE_ID: 1,
      CREATED_BY    : 1,
      AUDITORS      : [1],
      ACCOMPLICES   : [1],

      TAGS: tags,
      MARK: mark,

      DEADLINE        : srcTask.deadline,
      START_DATE_PLAN : srcTask.startDatePlan,
      END_DATE_PLAN   : srcTask.endDatePlan,
      TIME_ESTIMATE   : Number(srcTask.timeEstimate) || 0
    }
  };

  console.log("Criando:", payload.fields.TITLE);
  const { data } = await safeDstPost("tasks.task.add.json", payload);
  if (!data.result) throw new Error(JSON.stringify(data));
  return data.result.task.id;
}

/* ---------- 7. copiar comentários -------------------- */
async function copyComments(oldId, newId) {
  const { data } = await safeSrcGet("task.commentitem.getlist.json",
                                    { params: { taskId: oldId } });
  for (const c of data.result || []) {
    await safeDstPost("task.commentitem.add.json", {
      taskId: newId,
      fields: { POST_MESSAGE: c.POST_MESSAGE }
    });
  }
}

/* ---------- 8. migrar lista -------------------------- */
async function migrate(tasks) {
  for (const t of tasks) {
    if (migrated.has(t.id)) {
      console.log("🔸 já migrada:", t.id);
      continue;
    }
    try {
      const { tags, mark } = await getTagsAndMark(t.id);
      const newId = await createTask(t, tags, mark);
      await copyComments(t.id, newId);

      migrated.add(t.id);
      idmap[t.id] = newId;

      await fs.writeFile(DONE_FILE, JSON.stringify([...migrated]));
      await fs.writeFile(MAP_FILE , JSON.stringify(idmap, null, 2));

      console.log(`✅ ${t.id} → ${newId}`);
    } catch (e) {
      console.error(`❌ ${t.id}`, e.response?.data || e.message);
    }
  }
}

/* ---------- 9. rotas HTTP ---------------------------- */
const taskFile = process.env.TASK_FILE || "./tarefas_full_27.json";

app.get("/", (_, r) =>
  r.send("Migrador ativo • /migrar-teste ou /migrar"));

app.get("/migrar-teste", async (_, res) => {
  try {
    const raw = await fs.readFile(taskFile, "utf8");
    migrate(JSON.parse(raw).slice(0, 5))
      .then(() => console.log("🚀 teste OK"));
    res.send("Teste (5 tarefas) iniciou – veja o log.");
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/migrar", async (_, res) => {
  try {
    const raw = await fs.readFile(taskFile, "utf8");
    migrate(JSON.parse(raw))
      .then(() => console.log("🚀 migração completa"));
    res.send("Migração iniciou – veja o log.");
  } catch (e) { res.status(500).send(e.message); }
});

/* ---------- 10. start ------------------------------- */
app.listen(PORT, () =>
  console.log(`→ http://localhost:${PORT}\n   /migrar-teste  ou  /migrar`));
