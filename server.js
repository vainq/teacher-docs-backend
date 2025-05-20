require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { Document, Packer, Paragraph } = require('docx');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
const upload = multer({ dest: 'uploads/' });

mongoose.connect(process.env.MONGO_URI);

const User = mongoose.model('User', new mongoose.Schema({
  name: String, email: String, password: String
}));

const Lesson = mongoose.model('Lesson', new mongoose.Schema({
  teacherEmail: String,
  title: String,
  files: Object,
  outputs: Object,
  createdAt: { type: Date, default: Date.now }
}));

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ error: 'User exists' });
  const hashed = await bcrypt.hash(password, 10);
  await User.create({ email, password: hashed, name });
  const token = jwt.sign({ email, name }, 'secret', { expiresIn: '1h' });
  res.json({ token, name, email });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ email, name: user.name }, 'secret', { expiresIn: '1h' });
  res.json({ token, name: user.name, email });
});

app.get('/api/lessons', async (req, res) => {
  const { email } = req.query;
  const lessons = await Lesson.find({ teacherEmail: email });
  res.json(lessons);
});

async function saveAsWordAndPDF(title, content, type) {
  const baseName = `${type}-${Date.now()}`;
  const folder = path.join(__dirname, 'uploads');

  const doc = new Document({ sections: [{ children: [new Paragraph(content)] }] });
  const docxBuffer = await Packer.toBuffer(doc);
  const docxPath = path.join(folder, `${baseName}.docx`);
  fs.writeFileSync(docxPath, docxBuffer);

  const pdfPath = path.join(folder, `${baseName}.pdf`);
  const pdfDoc = new PDFDocument();
  pdfDoc.pipe(fs.createWriteStream(pdfPath));
  pdfDoc.fontSize(12).text(content);
  pdfDoc.end();

  return {
    docx: `/uploads/${baseName}.docx`,
    pdf: `/uploads/${baseName}.pdf`
  };
}

app.post('/api/generate-documents', upload.fields([
  { name: 'teacherGuide' }, { name: 'studentBook' }, { name: 'scheme' }
]), async (req, res) => {
  const { title, teacherEmail } = req.body;

  const extractText = async file => {
    const buffer = fs.readFileSync(file.path);
    const data = await pdfParse(buffer);
    return data.text;
  };

  const guideText = await extractText(req.files.teacherGuide[0]);
  const bookText = await extractText(req.files.studentBook[0]);
  const schemeText = await extractText(req.files.scheme[0]);

  const prompt = `Lesson Title: ${title}
Teacher Guide: ${guideText.slice(0, 3000)}
Student Book: ${bookText.slice(0, 3000)}
Scheme of Work: ${schemeText.slice(0, 3000)}
Based on the above, generate:
1. Lesson Plan
2. Lesson Notes
3. Homework/Assignment
4. Daily Class Record
Format using ###.`;

  const openai = new (require('openai').OpenAI)({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4
  });

  const output = completion.choices[0].message.content;
  const [lessonPlan, lessonNotes, assignment, dailyRecord] = output.split('###').map(x => x.trim());

  const lessonPlanFiles = await saveAsWordAndPDF(title, lessonPlan, 'lesson-plan');
  const notesFiles = await saveAsWordAndPDF(title, lessonNotes, 'lesson-notes');
  const assignmentFiles = await saveAsWordAndPDF(title, assignment, 'assignment');
  const recordFiles = await saveAsWordAndPDF(title, dailyRecord, 'daily-record');

  await Lesson.create({
    teacherEmail,
    title,
    files: {
      teacherGuide: req.files.teacherGuide[0].path,
      studentBook: req.files.studentBook[0].path,
      scheme: req.files.scheme[0].path
    },
    outputs: { lessonPlan, lessonNotes, assignment, dailyRecord }
  });

  res.json({
    lessonPlan: lessonPlanFiles,
    lessonNotes: notesFiles,
    assignment: assignmentFiles,
    dailyRecord: recordFiles
  });
});

app.listen(process.env.PORT || 5000, () => console.log('Backend running...'));
