// Proforma (prefactura): cómo va a quedar la factura, para revisarla antes de
// autorizarla en ARCA. No tiene número ni CAE y lo dice en grande: no es un
// comprobante fiscal. Misma estética que el presupuesto.

import { readFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { EMPRESA } from '../config/empresa.js';

type RGB = [number, number, number];
const AZUL_OSCURO: RGB = [27, 58, 140];
const AZUL: RGB = [0, 102, 255];
const AZUL_TABLA: RGB = [59, 130, 221];
const TEXTO: RGB = [30, 30, 30];
const GRIS: RGB = [110, 115, 125];
const LINEA: RGB = [220, 224, 232];
const ROJO: RGB = [200, 40, 45];

export interface DatosProforma {
    tipo: string;                               // A, B
    fecha: string;                              // yyyy-mm-dd
    cliente: { razon_social: string; cuit: string | null; condicion: string; domicilio?: string | null };
    renglones: Array<{ codigo: string | null; descripcion: string; cantidad: number; precio: number; iva: number; subtotal: number; iva_monto: number }>;
    una_linea: string | null;                   // se imprime como un solo renglón con esta descripción
    neto: number; iva: number; total: number;
    moneda: string; dolar: number | null;
    observaciones: string | null;
    referencia: string;                         // para el nombre del archivo
}

const pesos = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toLocaleString('es-AR')}%`;
const fechaAr = (f: string) => f.slice(0, 10).split('-').reverse().join('/');

let logoCache: string | null = null;
function logo(): string {
    if (!logoCache) logoCache = `data:image/png;base64,${readFileSync(new URL('../../assets/logo-bartez.png', import.meta.url)).toString('base64')}`;
    return logoCache;
}

export function generarProformaPdf(d: DatosProforma): { pdf: Buffer; archivo: string } {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 18;

    // ---- Encabezado ----
    doc.addImage(logo(), 'PNG', M, 12, 54, 13.8);
    doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(...AZUL_OSCURO);
    doc.text('PROFORMA', W - M, 20, { align: 'right' });
    doc.setFontSize(10).setTextColor(...ROJO);
    doc.text(`Borrador de Factura ${d.tipo} · sin validez fiscal`, W - M, 26.5, { align: 'right' });

    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...GRIS);
    doc.text(`${EMPRESA.descripcion}  -  ${EMPRESA.titular}  -  CUIT ${EMPRESA.cuit}  -  Responsable Inscripto`, M, 34);
    doc.text(`${EMPRESA.direccion}  -  ${EMPRESA.telefono}  -  ${EMPRESA.web}`, M, 38);
    doc.text(`Fecha: ${fechaAr(d.fecha)}`, W - M, 34, { align: 'right' });
    doc.setDrawColor(...AZUL).setLineWidth(0.6).line(M, 40.5, W - M, 40.5);
    doc.setLineWidth(0.2).line(M, 41.6, W - M, 41.6);

    // ---- Cliente ----
    let y = 50;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...AZUL_OSCURO);
    doc.text('CLIENTE', M, y);
    y += 7;
    doc.setFontSize(13).setTextColor(...TEXTO);
    const nombre = doc.splitTextToSize(d.cliente.razon_social, W - 2 * M) as string[];
    doc.text(nombre, M, y);
    y += nombre.length * 5.5;
    doc.setFont('helvetica', 'normal').setFontSize(9.5);
    for (const l of [d.cliente.cuit && `CUIT ${d.cliente.cuit}`, d.cliente.condicion, d.cliente.domicilio].filter(Boolean) as string[]) {
        doc.text(l, M, y);
        y += 4.8;
    }
    y += 5;

    // ---- Detalle ----
    const porTasa = new Map<number, { neto: number; iva: number }>();
    for (const r of d.renglones) {
        const a = porTasa.get(r.iva) ?? { neto: 0, iva: 0 };
        a.neto += r.subtotal; a.iva += r.iva_monto;
        porTasa.set(r.iva, a);
    }
    // Una sola línea: el renglón principal lleva el neto total; los productos van
    // debajo como detalle, sin precio (igual que la impresión consolidada de Asimov).
    const cuerpo: Array<Array<string | { content: string; styles?: Record<string, unknown> }>> = d.una_linea
        ? [
            ['1', d.una_linea, [...porTasa.keys()].length === 1 ? pct([...porTasa.keys()][0]!) : 'varias', pesos(d.neto), pesos(d.neto)],
            ...d.renglones.map((r) => [
                { content: String(r.cantidad), styles: { textColor: GRIS, fontSize: 8 } },
                { content: `   ${r.descripcion}`, styles: { textColor: GRIS, fontSize: 8 } },
                '', '', '',
            ]),
        ]
        : d.renglones.map((r) => [String(r.cantidad), r.codigo ? `${r.descripcion} (${r.codigo})` : r.descripcion, pct(r.iva), pesos(r.precio), pesos(r.subtotal)]);

    autoTable(doc, {
        startY: y,
        margin: { left: M, right: M },
        head: [['Cant.', 'Descripción', 'IVA', 'Unitario s/IVA', 'Subtotal s/IVA']],
        body: cuerpo,
        foot: [
            [{ content: 'Neto gravado', colSpan: 4 }, pesos(d.neto)],
            ...[...porTasa.entries()].sort((a, b) => a[0] - b[0]).map(([tasa, v]) => [{ content: `IVA ${pct(tasa)}`, colSpan: 4 }, pesos(Math.round(v.iva * 100) / 100)]),
        ],
        showFoot: 'lastPage',
        theme: 'plain',
        styles: { font: 'helvetica', fontSize: 9, cellPadding: { top: 2.4, bottom: 2.4, left: 3, right: 3 }, textColor: TEXTO, lineColor: LINEA },
        headStyles: { fillColor: AZUL_TABLA, textColor: 255, fontStyle: 'bold' },
        bodyStyles: { lineWidth: { bottom: 0.2 } },
        footStyles: { fillColor: [255, 255, 255], textColor: TEXTO, fontStyle: 'normal', lineWidth: { bottom: 0.2 } },
        columnStyles: {
            0: { cellWidth: 14, halign: 'center' },
            2: { cellWidth: 16, halign: 'center' },
            3: { cellWidth: 30, halign: 'right' },
            4: { cellWidth: 32, halign: 'right' },
        },
        didParseCell: (c) => {
            if (c.section === 'head' && (c.column.index === 3 || c.column.index === 4)) c.cell.styles.halign = 'right';
            if (c.section === 'head' && (c.column.index === 0 || c.column.index === 2)) c.cell.styles.halign = 'center';
            if (c.section === 'foot') c.cell.styles.halign = c.column.index === 4 ? 'right' : 'left';
        },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

    if (y > H - 60) { doc.addPage(); y = 20; }
    doc.setFillColor(...AZUL_OSCURO).rect(M, y, W - 2 * M, 11, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(255, 255, 255);
    doc.text('TOTAL', M + 3, y + 7.4);
    doc.text(pesos(d.total), W - M - 3, y + 7.4, { align: 'right' });
    y += 17;

    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...TEXTO);
    const notas = [
        d.moneda === 'USD' && d.dolar ? `Precios en dólares convertidos a pesos a ${pesos(d.dolar)} por dólar (total en dólares: US$ ${(d.total / d.dolar).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}).` : null,
        d.observaciones ? `Observaciones: ${d.observaciones}` : null,
    ].filter(Boolean) as string[];
    for (const n of notas) {
        const t = doc.splitTextToSize(n, W - 2 * M) as string[];
        doc.text(t, M, y);
        y += t.length * 4.2 + 1.5;
    }

    // Aviso grande: no es factura.
    y += 4;
    if (y > H - 40) { doc.addPage(); y = 20; }
    doc.setDrawColor(...ROJO).setLineWidth(0.4).rect(M, y, W - 2 * M, 14);
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...ROJO);
    doc.text('DOCUMENTO NO VÁLIDO COMO FACTURA', W / 2, y + 5.5, { align: 'center' });
    doc.setFont('helvetica', 'normal').setFontSize(8);
    doc.text('Proforma para revisar importes y datos. El comprobante fiscal se emite al autorizarlo en ARCA (con número y CAE).', W / 2, y + 10.5, { align: 'center' });

    // Marca de agua en cada página.
    const paginas = doc.getNumberOfPages();
    for (let i = 1; i <= paginas; i++) {
        doc.setPage(i);
        doc.saveGraphicsState();
        doc.setGState(new (doc as unknown as { GState: new (o: { opacity: number }) => unknown }).GState({ opacity: 0.07 }) as never);
        doc.setFont('helvetica', 'bold').setFontSize(80).setTextColor(...ROJO);
        doc.text('PROFORMA', W / 2, H / 2 + 20, { align: 'center', angle: 35 });
        doc.restoreGraphicsState();
        doc.setDrawColor(...AZUL).setLineWidth(0.4).line(M, H - 17, W - M, H - 17);
        doc.setFont('helvetica', 'normal').setFontSize(7.8).setTextColor(...GRIS);
        doc.text(`${EMPRESA.nombre}  -  Proforma sin validez fiscal`, M, H - 12);
        doc.text(`Página ${i}${paginas > 1 ? ` de ${paginas}` : ''}`, W - M, H - 12, { align: 'right' });
    }

    const base = d.cliente.razon_social.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'cliente';
    return { pdf: Buffer.from(doc.output('arraybuffer')), archivo: `Proforma_${d.tipo}_${base}_${d.referencia}.pdf` };
}
