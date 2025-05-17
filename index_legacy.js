/* ---------------------------------------------------------
 *  Bitrix Migrador – tarefas + comentários + anexos
 * --------------------------------------------------------*/

import express     from "express";
import axios       from "axios";
import fs          from "fs/promises";
import path        from "path";
import dotenv      from "dotenv";
import Bottleneck  from "bottleneck";
import FormData    from "form-data";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

/* ---------- 1. mapeamento de etapas -------------------- */
const stageMap = {
  337: 101, 339: 106, 389: 103, 341: 105,
  499: 108, 501: 110, 621: 112, 373: 114,
  653: 116, 371: 118, 375: 120, 377: 122,
  593: 124
};

/* ---------- 2. instâncias axios ------------------------ */
const src = axios.create({
  baseURL: `${process.env.SRC_DOMAIN}/rest/${process.env.SRC_USER}/${process.env.SRC_TOKEN}/`,
  timeout: 20000
});
const dst = axios.create({
  baseURL: `${process.env.DST_DOMAIN}/rest/${process.env.DST_USER}/${process.env.DST_TOKEN}/`,
  timeout: 20000
});

/* ---------- 3. Bottleneck 1 req/s ---------------------- */
const limiter      = new Bottleneck({ minTime: 1000, maxConcurrent: 1 });
const safeSrcGet   = (...a) => limiter.schedule(() => src.get (...a));
const safeDstPost  = (...a) => limiter.schedule(() => dst.post(...a));
limiter.on("executing", () =>
  console.log("➡️  REST", new Date().toLocaleTimeString()));

/* ---------- 4. controle de duplicados ------------------ */
const MIG_FILE = "./migrados.json";
let migrated = new Set();
try {
  const txt = await fs.readFile(MIG_FILE, "utf8");
  migrated = new Set(JSON.parse(txt));
} catch { /* primeiro uso: arquivo ainda não existe */ }

/* ---------- 5. obter IDs de anexos da tarefa ----------- */
async function getSourceFileIds(taskId) {
  try {
    const { data } = await safeSrcGet("tasks.task.get", { params: { taskId } });
    const t = data.result.task;
    let ids = t.ATTACHMENT || [];

    // Suporta WebDAV antigo (UF_TASK_WEBDAV_FILES)
    if (t.UF_TASK_WEBDAV_FILES && t.UF_TASK_WEBDAV_FILES.length) {
      const extra = t.UF_TASK_WEBDAV_FILES
        .map(s => s.split(":").pop())
        .filter(Boolean);
      ids = ids.concat(extra);
    }
    return ids;
  } catch (e) {
    console.error("Erro obtendo anexos", taskId, e.message);
    return [];
  }
}

/* ---------- 6. copiar anexos origem → destino ---------- */
const DEST_FOLDER_ID = process.env.DST_FOLDER_ID || 1;

async function copyAttachments(fileIds) {
  const newFileIds = [];
  for (const fid of fileIds) {
    try {
      // metadados + link de download
      const meta = await safeSrcGet("disk.file.get", { params: { id: fid } });
      const fileInfo = meta.data.result.file;
      const dlUrl    = fileInfo.DOWNLOAD_URL;

      // download binário
      const bin = await axios.get(dlUrl, { responseType: "arraybuffer" });

      // upload destino
      const form = new FormData();
      form.append("id", DEST_FOLDER_ID);
      form.append("data[NAME]", fileInfo.NAME);
      form.append("file", Buffer.from(bin.data), fileInfo.NAME);

      const up = await safeDstPost("disk.folder.uploadfile",
                                   form,
                                   { headers: form.getHeaders() });

      newFileIds.push(up.data.result.file.id);
    } catch (err) {
      console.error("Erro copiando arquivo", fid,
                    err.response?.data || err.message);
    }
  }
  return newFileIds;
}

/* ---------- 7. criar tarefa no destino ----------------- */
async function createTask(srcTask, newFileIds) {
  const payload = {
    fields: {
      TITLE:        srcTask.title,
      DESCRIPTION:  srcTask.description,
      STATUS:       Number(srcTask.status) || 1,
      GROUP_ID:     Number(process.env.DST_GROUP_ID),
      STAGE_ID:     stageMap[srcTask.stageId] || 101,
      RESPONSIBLE_ID: 1,  CREATED_BY: 1,
      AUDITORS: [1], ACCOMPLICES: [1],
      ATTACHMENT: newFileIds,
      DEADLINE:        srcTask.deadline,
      START_DATE_PLAN: srcTask.startDatePlan,
      END_DATE_PLAN:   srcTask.endDatePlan,
      TIME_ESTIMATE:   Number(srcTask.timeEstimate) || 0
    }
  };
  console.log("Criando:", payload.fields.TITLE);
  const { data } = await safeDstPost("tasks.task.add.json", payload);
  if (!data.result) throw new Error(JSON.stringify(data));
  return data.result.task.id;
}

/* ---------- 8. copiar comentários ---------------------- */
async function copyComments(oldId, newId) {
  const { data } = await safeSrcGet("task.commentitem.getlist.json",
                                    { params: { taskId: oldId } });
  const comments = data.result || [];
  for (const c of comments) {
    await safeDstPost("task.commentitem.add.json", {
      taskId: newId,
      fields: { POST_MESSAGE: c.POST_MESSAGE }
    });
  }
}

/* ---------- 9. migrar lista de tarefas ----------------- */
async function migrate(tasks) {
  for (const t of tasks) {
    if (migrated.has(t.id)) {
      console.log(`🔸 já migrada: ${t.id}`);
      continue;
    }
    try {
      const srcFileIds = await getSourceFileIds(t.id);
      const newFileIds = await copyAttachments(srcFileIds);
      const newTaskId  = await createTask(t, newFileIds);
      await copyComments(t.id, newTaskId);

      migrated.add(t.id);
      await fs.writeFile(MIG_FILE, JSON.stringify([...migrated]));

      console.log(`✅ ${t.id} → ${newTaskId}`);
    } catch (e) {
      console.error(`❌ ${t.id}`, e.response?.data || e.message);
    }
  }
}

/* ---------- 10. rotas HTTP ----------------------------- */
app.get("/", (_, r) =>
  r.send("Bitrix migrador ativo — use /migrar-teste ou /migrar."));

app.get("/migrar-teste", async (_, res) => {
  try {
    const raw   = await fs.readFile("./tarefas_unificadas.json", "utf8");
    const tasks = JSON.parse(raw).slice(0, 5);
    migrate(tasks).then(() => console.log("🚀 teste OK"));
    res.send("Iniciou migração-teste (5 tarefas). Veja o log.");
  } catch (e) { res.status(500).send(e.message); }
});

app.get("/migrar", async (_, res) => {
  try {
    const raw   = await fs.readFile("./tarefas_unificadas.json", "utf8");
    const tasks = JSON.parse(raw);
    migrate(tasks).then(() => console.log("🚀 migração completa"));
    res.send(`Iniciou migração de ${tasks.length} tarefas. Veja o log.`);
  } catch (e) { res.status(500).send(e.message); }
});

/* ---------- 11. start ---------------------------------- */
app.listen(PORT, () =>
  console.log(`→ http://localhost:${PORT}\n   /migrar-teste ou /migrar`));
