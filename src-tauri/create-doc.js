import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import fs from 'fs';

// Create a basic Word document
const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 24 } } }, // 12pt default font
    paragraphStyles: [
      {
        id: 'Title',
        name: 'Title',
        run: { size: 56, bold: true, color: '000000', font: 'Arial' },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 240, after: 120 } }
      }
    ]
  },
  sections: [{
    properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('My First Document')] }),
      new Paragraph({ children: [new TextRun('This is a simple Word document created with the docx library.')] })
    ]
  }]
});

// Save the document
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync('output.docx', buffer);
  console.log('Document created successfully: output.docx');
});