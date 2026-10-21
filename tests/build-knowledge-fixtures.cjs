'use strict';
const fs=require('node:fs'),path=require('node:path'),XLSX=require('xlsx'),{zipSync,strToU8}=require('fflate'),PDFDocument=require('pdfkit');
const dest=path.join(__dirname,'fixtures/knowledge');fs.mkdirSync(dest,{recursive:true});
const zip=parts=>Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,strToU8(v)]))));
const write=(name,data)=>fs.writeFileSync(path.join(dest,name),data);
const rels='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const docType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const types=(body)=>`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${body}</Types>`;
const docParts={
 '[Content_Types].xml':types(`<Override PartName="/word/document.xml" ContentType="${docType}"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`),
 '_rels/.rels':rels+'<Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
 'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Bitpype DOCX café fixture</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table marker 2468</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/></w:sectPr></w:body></w:document>',
 'word/_rels/document.xml.rels':rels+'<Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
 'word/header1.xml':'<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header marker</w:t></w:r></w:p></w:hdr>',
 'word/footer1.xml':'<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Footer marker</w:t></w:r></w:p></w:ftr>',
};
write('document.docx',zip(docParts));
const pns='xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const slide=text=>`<p:sld ${pns}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
write('slides.pptx',zip({
 '[Content_Types].xml':types('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'),
 '_rels/.rels':rels+'<Relationship Id="rPpt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
 'ppt/presentation.xml':'<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s2"/></p:sldIdLst></p:presentation>',
 'ppt/_rels/presentation.xml.rels':rels+'<Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="s2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
 'ppt/slides/slide1.xml':slide('Bitpype slide one café'), 'ppt/slides/slide2.xml':slide('Second slide marker 2468'),
}));
const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Name','Amount','Date'],['Café, fixture',42,new Date('2026-10-20T00:00:00Z')],['Formula',2,'Text "quoted"']]),'Fixture');XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Second sheet marker'],['Unicode 東京']]),'Second');
for(const [name,type] of [['book.xlsx','xlsx'],['legacy.xls','biff8']])write(name,XLSX.write(wb,{type:'buffer',bookType:type,cellDates:true}));
write('data.csv',Buffer.from('Name,Value\n"Café, fixture",42\n"Quoted ""value""",2468\n'));
write('note.txt',Buffer.from('Bitpype plain text café fixture 2468'));
write('page.html',Buffer.from('<style>SECRET_STYLE</style><script>SECRET_SCRIPT</script><h1>Bitpype HTML fixture 2468</h1>'));
const pdf=new PDFDocument({compress:false});const chunks=[];pdf.on('data',b=>chunks.push(b));pdf.on('end',()=>{write('document.pdf',Buffer.concat(chunks));console.log('Knowledge fixtures generated')});pdf.fontSize(18).text('Bitpype PDF fixture 2468');pdf.end();
