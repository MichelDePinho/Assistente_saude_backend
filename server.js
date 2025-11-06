// server.js
const express = require('express');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- Configurações Supabase ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Middlewares ---
app.use(cors({
  origin: [
    'https://assistente-saude-frontend.vercel.app',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Avisa ao Express para confiar no proxy (Vercel/Render)
app.set('trust proxy', 1);

// Limite de tamanho do corpo
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiter para evitar abuso
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100
});
app.use(limiter);

// --- Helpers ---
async function saveReportToSupabase(record) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const { data, error } = await supabase
    .from('reports')
    .insert([record])
    .select();
  if (error) {
    console.error('Supabase error:', error);
    return null;
  }
  return data[0] || null;
}

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
      const PDFDocument = require('pdfkit');
      const fs = require('fs');
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      // 🎨 CORES E FONTES
      const primaryColor = '#2E86C1';  // azul principal
      const textColor = '#222';
      const gray = '#555';

      // 🔹 Cabeçalho com faixa azul
      doc.rect(0, 0, doc.page.width, 80).fill(primaryColor);
      if (logoPath && fs.existsSync(logoPath)) {
        doc.image(logoPath, 50, 20, { width: 60 });
      }
      doc.fillColor('white').fontSize(20).text('Assistente de Bem-Estar', 130, 35);
      doc.moveDown(2);
      doc.fillColor(textColor);

      doc.moveDown(1.5);

      // 🧍 Informações do usuário
      doc.fontSize(12).text(`Nome: ${name}`, { continued: true }).fillColor(gray);
      if (email) doc.text(`   |   Email: ${email}`);
      doc.moveDown(0.5);
      doc.fillColor(gray).fontSize(10).text(`Gerado em: ${new Date().toLocaleString()}`);
      doc.moveDown(1.5);

      // 🧾 Seção: Respostas
      doc.fillColor(primaryColor).fontSize(14).text('Respostas do Formulário', { underline: true });
      doc.moveDown(0.5);
      doc.fillColor(textColor).fontSize(11);

      // Caixa de fundo leve para as respostas
      const startY = doc.y;
      doc.rect(45, startY - 5, doc.page.width - 90, 0.001).strokeColor(primaryColor).stroke();
      doc.moveDown(0.5);

      for (const [question, answer] of Object.entries(responses || {})) {
        doc.font('Helvetica-Bold').text(`• ${question}`);
        doc.font('Helvetica-Oblique').fillColor(gray).text(`  ${answer}`, { indent: 12 });
        doc.fillColor(textColor);
        doc.moveDown(0.3);
      }

      doc.moveDown(1.2);

      // 💬 Seção: Análise e Recomendações
      doc.fillColor(primaryColor).fontSize(14).text('Análise e Recomendações', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor(textColor);

      // Caixa com fundo azul claro para destaque
      const analysisY = doc.y;
      const boxWidth = doc.page.width - 90;
      const textHeight = doc.heightOfString(analysis, { width: boxWidth });
      doc.rect(45, analysisY - 8, boxWidth, textHeight + 16).fillOpacity(0.05).fill(primaryColor);
      doc.fillOpacity(1).fillColor(textColor);
      doc.text(analysis, 55, analysisY, { width: boxWidth - 20, align: 'justify' });

      doc.moveDown(2);

      // 🔻 Rodapé com número de página
      const pages = doc.bufferedPageRange();
      for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(9).fillColor(gray)
          .text(`Assistente de Bem-Estar — Página ${i + 1} de ${pages.count}`, 50, doc.page.height - 40, {
            align: 'center',
            width: doc.page.width - 100
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// --- Endpoints ---

// Análise + geração PDF
app.post('/api/analyze', async (req, res) => {
  try {
    const { name, email, responses, logoBase64 } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

    const systemPrompt = 'Você é um assistente de bem-estar que produz recomendações práticas e passo-a-passo.';
    let userPrompt = `Usuario: ${name}\nEmail: ${email}\nRespostas:\n`;
    for (const [q, a] of Object.entries(responses || {})) {
      userPrompt += `- ${q}: ${a}\n`;
    }
    userPrompt += '\nGere um relatório com análise breve e 5 recomendações práticas.';

    let analysis;
    try {
      analysis = await callOpenAI(systemPrompt, userPrompt);
    } catch (e) {
      console.error('OpenAI failed, usando fallback', e);
      analysis = 'Não foi possível obter análise da IA. Aqui está um relatório de fallback:\n- Rotina de sono\n- Exercício regular\n- Alimentação equilibrada\n- Hidratação\n- Pausas durante o trabalho';
    }

    // Salvar logo
    let logoPath = null;
    if (logoBase64) {
      try {
        const matches = logoBase64.match(/^data:(image\/\w+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1].split('/')[1];
          const data = Buffer.from(matches[2], 'base64');
          fs.mkdirSync('./uploads', { recursive: true });
          logoPath = `./uploads/logo_${Date.now()}.${ext}`;
          fs.writeFileSync(logoPath, data);
        }
      } catch (err) {
        console.error('Falha ao salvar logo, seguindo sem logo', err);
      }
    }

    const pdfBuffer = await generatePDFBuffer({ name, email, responses, analysis, logoPath });

    // Salvar no Supabase (não bloqueia envio PDF)
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
        console.error('Falha ao salvar no Supabase', err);
      }
    })();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="relatorio_${name.replace(/\s+/g,'_')}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// Teste de saúde
app.get('/api/health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// Listar relatórios
app.get('/api/reports', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar relatórios' });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});
