/* ---------------------------------------------------------
 *  exporta_tarefas.js
 *  → baixa todas as tarefas de um grupo Bitrix24
 *    em blocos de 50 e grava em tarefas_full.json
 * --------------------------------------------------------*/
import axios      from "axios";
import Bottleneck from "bottleneck";
import fs         from "fs/promises";
import dotenv     from "dotenv";
dotenv.config();

/* ---------- parâmetros --------------------------------- */
const GROUP_ID   = process.argv[2] || process.env.EXPORT_GROUP_ID;
if (!GROUP_ID) {
  console.error("✖️  Informe o GROUP_ID:  node exporta_tarefas.js 27");
  process.exit(1);
}
const OUT_FILE   = `tarefas_full_${GROUP_ID}.json`;

/* ---------- axios + limitador (1 req/s) ---------------- */
const src  = axios.create({
  baseURL: `${process.env.SRC_DOMAIN}/rest/${process.env.SRC_USER}/${process.env.SRC_TOKEN}/`,
  timeout: 20000
});
const lim  = new Bottleneck({ minTime: 1000, maxConcurrent: 1 });
const safe = (...a) => lim.schedule(() => src.get(...a));

/* ---------- função principal --------------------------- */
(async () => {
  let all   = [];
  let start = 0;

  while (true) {
    console.log(`➡️  buscando start=${start}`);
    const { data } = await safe("tasks.task.list", {
      params: {
        ["filter[GROUP_ID]"]: GROUP_ID,
        start
      }
    });

    const tasks = data.result.tasks || [];
    all = all.concat(tasks);

    if (tasks.length < 50) break;   // último bloco
    start += 50;
  }

  await fs.writeFile(OUT_FILE, JSON.stringify(all, null, 2));
  console.log(`✅ gravado ${all.length} tarefas em ${OUT_FILE}`);
})().catch(err => {
  console.error("Erro:", err.response?.data || err.message);
});
