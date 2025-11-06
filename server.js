const express = require('express');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3333;

// rate limiter to avoid abuse during demos
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30
});
app.use(limiter);

// Supabase REST endpoint helper (uses service key)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function saveReportToSupabase(record) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/reports`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(record)
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Supabase error:', text);
    return null;
  }
  const data = await res.json();
  return data[0] || null;
}

// helper: call OpenAI (if key present).
async function callOpenAI(systemPrompt, userPrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return `RELATÓRIO DE EXEMPLO:
- Avaliação geral: Sono regular, necessidade de aumento de atividade física.
- 5 recomendações práticas: Estabelecer rotina de sono; Exercício 30 min 3x/semana; Planejar refeições; Hidratar; Pausas ativas.
(Defina OPENAI_API_KEY para análises reais)`;
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 900,
    temperature: 0.7
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    console.error('OpenAI error', t);
    throw new Error('Erro ao chamar OpenAI: ' + t);
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const text = choice?.message?.content || choice?.text || '';
  return text.trim();
}

function generatePDFBuffer({ name, email, responses, analysis, logoPath }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // Header
      if (logoPath && fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 80 });
      }
      doc.fontSize(18).text('Assistente de Bem-estar', 150, 50);
      doc.fontSize(10).text(`Gerado em: ${new Date().toLocaleString()}`, { align: 'right' });
      doc.moveDown(2);

      // User block
      doc.moveDown();
      doc.fontSize(12).fillColor('#333').text(`Nome: ${name}`, { continued: false });
      if (email) doc.text(`Email: ${email}`);
      doc.moveDown();

      // Responses
      doc.fontSize(13).fillColor('#111').text('Respostas do formulário:', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11);
      for (const [q, a] of Object.entries(responses || {})) {
        doc.text(`• ${q}`, { continued: false });
        doc.font('Helvetica-Oblique').text(`  ${a}`, { indent: 12 });
        doc.font('Helvetica');
      }

      doc.moveDown();
      // Analysis
      doc.moveDown();
      doc.fontSize(13).fillColor('#111').text('Análise e recomendações:', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#000');
      doc.text(analysis, { align: 'justify' });

      // Footer with page numbers
      const pages = doc.bufferedPageRange(); // { start: 0, count: N }
      for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(9).fillColor('#666')
          .text(`Assistente de Bem-estar — Página ${i + 1} de ${pages.count}`, 50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { name, email, responses, logoBase64 } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

    const systemPrompt = 'Você é um assistente de bem-estar que produz recomendações práticas, objetivas e passo-a-passo com base nas respostas do usuário.';
    let userPrompt = `Usuario: ${name}\nEmail: ${email}\nRespostas:\n`;
    for (const [q, a] of Object.entries(responses || {})) {
      userPrompt += `- ${q}: ${a}\n`;
    }
    userPrompt += '\nGere um relatório com análise breve e 5 recomendações práticas, cada uma com passos acionáveis.';

    let analysis;
    try {
      analysis = await callOpenAI(systemPrompt, userPrompt);
    } catch (e) {
      console.error('OpenAI failed, using fallback', e);
      analysis = 'Não foi possível obter análise da IA. Aqui está um relatório de fallback com recomendações básicas:\n- Rotina de sono\n- Exercício regular\n- Alimentação equilibrada\n- Hidratação\n- Pausas durante o trabalho';
    }

    // optionally save logo to disk (if base64 provided)
    let logoPath = null;
    if (logoBase64) {
      try {
        const matches = logoBase64.match(/^data:(image\/\w+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1].split('/')[1];
          const data = Buffer.from(matches[2], 'base64');
          logoPath = `./uploads/logo_${Date.now()}.${ext}`;
          fs.mkdirSync('./uploads', { recursive: true });
          fs.writeFileSync(logoPath, data);
        }
      } catch (err) {
        console.error('logo save failed', err);
      }
    }

    const pdfBuffer = await generatePDFBuffer({ name, email, responses, analysis, logoPath });

    // Save metadata to Supabase (non-blocking)
    (async () => {
      try {
        const saved = await saveReportToSupabase({
          name,
          email,
          responses,
          analysis,
          created_at: new Date().toISOString()
        });
        if (saved) console.log('Saved report to Supabase id=', saved.id || saved);
      } catch (err) {
        console.error('Failed saving to supabase', err);
      }
    })();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="relatorio_${name.replace(/\\s+/g,'_')}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    return res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});
