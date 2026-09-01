/* eslint-disable jsdoc/require-jsdoc */

import JSZip from 'jszip';

import { ExcelParser, PPTParser, WordParser } from './office-parser';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64'
);

async function makeDocx(includeImage = false): Promise<Buffer> {
    const zip = new JSZip();
    const image = includeImage
        ? '<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>'
        : '';
    zip.file(
        'word/document.xml',
        `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
          <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          ${image}<w:p><w:r><w:t>World</w:t></w:r></w:p>
        </w:body></w:document>`
    );
    if (includeImage) {
        zip.file(
            'word/_rels/document.xml.rels',
            '<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>'
        );
        zip.file('word/media/image1.png', PNG);
    }
    return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        'ppt/presentation.xml',
        '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>'
    );
    zip.file(
        'ppt/_rels/presentation.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'
    );
    zip.file(
        'ppt/slides/slide1.xml',
        `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>
          <p:sp><p:txBody><a:p><a:r><a:t>Alpha</a:t></a:r></a:p></p:txBody></p:sp>
          <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
            <a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
            <a:tr><a:tc><a:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
          <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>
        </p:spTree></p:cSld></p:sld>`
    );
    zip.file(
        'ppt/slides/_rels/slide1.xml.rels',
        '<Relationships><Relationship Id="rId2" Target="../media/image1.png"/></Relationships>'
    );
    zip.file('ppt/media/image1.png', PNG);
    return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeXlsx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        'xl/workbook.xml',
        '<workbook xmlns:r="r"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>'
    );
    zip.file(
        'xl/_rels/workbook.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    );
    zip.file(
        'xl/worksheets/sheet1.xml',
        `<worksheet><sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Age</t></is></c></row>
          <row r="2"><c r="A2" t="inlineStr"><is><t>Alice</t></is></c><c r="B2"><v>25</v></c></row>
        </sheetData></worksheet>`
    );
    return zip.generateAsync({ type: 'nodebuffer' });
}

describe('Office parser Python parity', () => {
    test('Word preserves paragraph/table order and separation', async () => {
        const merged = await new WordParser({ include_image: false }).parse(
            await makeDocx(),
            'demo.docx'
        );
        expect(
            merged.map(section => (section.content.type === 'text' ? section.content.text : ''))
        ).toEqual(['Hello\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nWorld']);
        const separated = await new WordParser({
            include_image: false,
            separate_table: true,
        }).parse(await makeDocx(), 'demo.docx');
        expect(
            separated.map(section => (section.content.type === 'text' ? section.content.text : ''))
        ).toEqual(['Hello', '| A | B |\n| --- | --- |\n| 1 | 2 |\n', 'World']);
    });

    test('Word emits embedded image sections', async () => {
        const sections = await new WordParser().parse(await makeDocx(true), 'rich.docx');
        expect(sections.map(section => section.content.type)).toEqual(['text', 'data', 'text']);
        expect(sections[1]).toEqual(
            expect.objectContaining({
                content: expect.objectContaining({
                    name: 'rich.docx',
                    source: expect.objectContaining({ media_type: 'image/png' }),
                }),
                metadata: { media_type: 'image/png' },
            })
        );
    });

    test('PPT preserves shape boundaries, tables, images, and wrappers', async () => {
        const sections = await new PPTParser({ separate_table: true }).parse(
            await makePptx(),
            'demo.pptx'
        );
        expect(
            sections.map(section =>
                section.content.type === 'text' ? section.content.text : section.content.type
            )
        ).toEqual([
            '<slide index=1>\nAlpha',
            '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
            'data',
            '</slide>',
        ]);
        expect(sections.map(section => section.metadata)).toEqual([
            { slide: 1 },
            { slide: 1 },
            { slide: 1, media_type: 'image/png' },
            { slide: 1 },
        ]);
    });

    test('Excel renders sheets with names and coordinates', async () => {
        const bytes = await makeXlsx();
        const sections = await new ExcelParser().parse(bytes, 'demo.xlsx');
        expect(
            sections.map(section => (section.content.type === 'text' ? section.content.text : ''))
        ).toEqual(['Sheet: Data\n| Name | Age |\n| --- | --- |\n| Alice | 25 |\n']);
        const coordinateSections = await new ExcelParser({
            include_cell_coordinates: true,
            separate_sheet: true,
        }).parse(bytes, 'demo.xlsx');
        expect(coordinateSections[0]).toEqual(
            expect.objectContaining({
                content: expect.objectContaining({
                    text: 'Sheet: Data\n| [A1] Name | [B1] Age |\n| --- | --- |\n| [A2] Alice | [B2] 25 |\n',
                }),
                metadata: { sheet: 'Data' },
            })
        );
    });

    test('validates table formats and exposes canonical extensions', () => {
        expect(() => new WordParser({ table_format: 'csv' as 'markdown' })).toThrow();
        expect(() => new PPTParser({ table_format: 'csv' as 'markdown' })).toThrow();
        expect(() => new ExcelParser({ table_format: 'csv' as 'markdown' })).toThrow();
        expect(WordParser.supportedExtensions).toEqual(['.docx']);
        expect(PPTParser.supportedExtensions).toEqual(['.pptx']);
        expect(ExcelParser.supportedExtensions).toEqual(['.xls', '.xlsx']);
    });
});
