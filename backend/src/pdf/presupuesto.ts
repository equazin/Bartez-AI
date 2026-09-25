// PDF de presupuesto con el diseño del presupuesto modelo de Bartez.
// Solo incluye lo que ve el cliente: nunca proveedor, SKU del mayorista, costo
// ni alternativas. Se genera en el backend para que el mismo archivo sirva
// para descargarlo desde el Cotizador y para adjuntarlo a un correo.

import { readFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { CIERRE, CONDICIONES, EMPRESA, NOTA_PRECIOS } from '../config/empresa.js';
import type { CotizacionGuardada } from '../orchestrator/cotizador.js';

type Cotizacion = Pick<CotizacionGuardada, 'lineas' | 'titulo' | 'datos_cliente' | 'creado_en' | 'subtotal_usd' | 'total_usd'>;

type RGB = [number, number, number];
const AZUL_OSCURO: RGB = [27, 58, 140];
const AZUL: RGB = [0, 102, 255];
const AZUL_TABLA: RGB = [59, 130, 221];
const TEXTO: RGB = [30, 30, 30];
const GRIS: RGB = [110, 115, 125];
const FONDO_ETIQ: RGB = [236, 240, 247];
const LINEA: RGB = [220, 224, 232];

const usd = (n: number) => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toLocaleString('es-AR')}%`;

export function numeroFormateado(c: Cotizacion, numero?: number | null): string {
    const anio = (c.creado_en ? new Date(c.creado_en) : new Date()).getFullYear();
    return numero ? `${anio}-${String(numero).padStart(4, '0')}` : 'BORRADOR';
}

// "NB" es la abreviatura de Air: al cliente se le muestra "Notebook".
function descripcionCliente(desc: string, marca: string | null): string {
    const base = desc.replace(/^NB\b/i, 'Notebook');
    return marca && !base.toUpperCase().includes(marca.toUpperCase()) ? `${marca} ${base}` : base;
}

export function objetoPorDefecto(c: Cotizacion): string {
    const lineas = c.lineas.filter((l) => l.elegido);
    if (lineas.length === 1) {
        const l = lineas[0]!;
        return `Provisión de ${l.cantidad} x ${descripcionCliente(l.elegido!.descripcion, l.elegido!.marca)}.`;
    }
    const unidades = lineas.reduce((s, l) => s + l.cantidad, 0);
    return `Provisión de equipamiento IT según detalle: ${lineas.length} ítems, ${unidades} unidades en total.`;
}

let logoCache: string | null = null;
function cargarLogo(): string {
    if (!logoCache) {
        const png = readFileSync(new URL('../../assets/logo-bartez.png', import.meta.url));
        logoCache = `data:image/png;base64,${png.toString('base64')}`;
    }
    return logoCache;
}

export function nombreArchivo(cliente: string, numero: string): string {
    const base = (cliente || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `Presupuesto_${numero}_${base || 'cliente'}.pdf`;
}

export function generarPresupuestoPdf(c: Cotizacion, numero?: number | null): { pdf: Buffer; archivo: string } {
    const logo = cargarLogo();
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 18;
    const num = numeroFormateado(c, numero);
    const fecha = (c.creado_en ? new Date(c.creado_en) : new Date())
        .toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const dc = c.datos_cliente ?? {};
    const cliente = (c.titulo ?? '').trim();

    // ---- Encabezado ----
    doc.addImage(logo, 'PNG', M, 12, 54, 13.8);
    doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(...AZUL_OSCURO);
    doc.text('PRESUPUESTO', W - M, 21, { align: 'right' });
    doc.setFontSize(12).setTextColor(...AZUL);
    doc.text(`N ${num}`, W - M, 28, { align: 'right' });

    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...GRIS);
    doc.text(`${EMPRESA.descripcion}  -  ${EMPRESA.titular}  -  CUIT ${EMPRESA.cuit}`, M, 34);
    doc.text(`${EMPRESA.direccion}  -  ${EMPRESA.telefono}  -  ${EMPRESA.web}`, M, 38);
    doc.text(`Fecha: ${fecha}`, W - M, 34, { align: 'right' });
    if (cliente) doc.text(`Cliente: ${cliente}`, W - M, 38, { align: 'right' });
    doc.setDrawColor(...AZUL).setLineWidth(0.6).line(M, 40.5, W - M, 40.5);
    doc.setLineWidth(0.2).line(M, 41.6, W - M, 41.6);

    // ---- Presupuesto para / Objeto ----
    const mitad = W / 2;
    let yIzq = 51;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...AZUL_OSCURO);
    doc.text('PRESUPUESTO PARA', M, yIzq);
    yIzq += 8;
    doc.setFontSize(15).setTextColor(...TEXTO);
    const nombreCli = doc.splitTextToSize(cliente || '—', mitad - M - 6) as string[];
    doc.text(nombreCli, M, yIzq);
    yIzq += nombreCli.length * 6 + 0.5;
    doc.setFont('helvetica', 'normal').setFontSize(9.5);
    for (const l of [
        dc.cuit && `CUIT ${dc.cuit}`,
        dc.direccion,
        dc.localidad,
        dc.atencion && `At.: ${dc.atencion}`,
    ].filter(Boolean) as string[]) {
        doc.text(l, M, yIzq);
        yIzq += 4.8;
    }

    let yDer = 51;
    const xDer = mitad + 4;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...AZUL_OSCURO);
    doc.text('OBJETO DEL PRESUPUESTO', xDer, yDer);
    yDer += 6;
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...TEXTO);
    const objeto = doc.splitTextToSize((dc.objeto || objetoPorDefecto(c)).trim(), W - M - xDer) as string[];
    doc.text(objeto, xDer, yDer);
    yDer += objeto.length * 4.8;

    const yBloque = Math.max(yIzq, yDer) + 2;
    doc.setDrawColor(...LINEA).setLineWidth(0.3).line(mitad, 46, mitad, yBloque);
    let y = yBloque + 9;

    // ---- Detalle ----
    doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(...AZUL_OSCURO);
    doc.text('Detalle', M, y);
    y += 3;

    const lineas = c.lineas.filter((l) => l.elegido);
    const ivaPorTasa = new Map<number, number>();
    for (const l of lineas) {
        const e = l.elegido!;
        const iva = (e.precio_unit_final_usd - e.precio_unit_usd) * l.cantidad;
        ivaPorTasa.set(e.iva_pct, (ivaPorTasa.get(e.iva_pct) ?? 0) + iva);
    }

    autoTable(doc, {
        startY: y,
        margin: { left: M, right: M },
        head: [['Cant.', 'Descripción (precio neto sin IVA)', 'IVA', 'Unitario', 'Monto']],
        body: lineas.map((l) => {
            const e = l.elegido!;
            return [String(l.cantidad), descripcionCliente(e.descripcion, e.marca), pct(e.iva_pct), usd(e.precio_unit_usd), usd(e.precio_unit_usd * l.cantidad)];
        }),
        foot: [
            [{ content: 'Subtotal (neto sin IVA)', colSpan: 4 }, usd(c.subtotal_usd)],
            ...[...ivaPorTasa.entries()].sort((a, b) => a[0] - b[0])
                .map(([tasa, monto]) => [{ content: `IVA ${pct(tasa)}`, colSpan: 4 }, usd(monto)]),
        ],
        showFoot: 'lastPage',
        theme: 'plain',
        styles: { font: 'helvetica', fontSize: 9, cellPadding: { top: 2.6, bottom: 2.6, left: 3, right: 3 }, textColor: TEXTO, lineColor: LINEA },
        headStyles: { fillColor: AZUL_TABLA, textColor: 255, fontStyle: 'bold' },
        bodyStyles: { lineWidth: { bottom: 0.2 } },
        footStyles: { fillColor: [255, 255, 255], textColor: TEXTO, fontStyle: 'normal', lineWidth: { bottom: 0.2 } },
        columnStyles: {
            0: { cellWidth: 16, halign: 'center' },
            2: { cellWidth: 15, halign: 'center' },
            3: { cellWidth: 27, halign: 'right' },
            4: { cellWidth: 29, halign: 'right' },
        },
        didParseCell: (d) => {
            // Encabezados numéricos alineados como sus columnas.
            if (d.section === 'head' && (d.column.index === 3 || d.column.index === 4)) d.cell.styles.halign = 'right';
            if (d.section === 'head' && (d.column.index === 0 || d.column.index === 2)) d.cell.styles.halign = 'center';
            if (d.section === 'foot') d.cell.styles.halign = d.column.index === 4 ? 'right' : 'left';
        },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

    // Barra de TOTAL FINAL.
    if (y > H - 60) { doc.addPage(); y = 20; }
    doc.setFillColor(...AZUL_OSCURO).rect(M, y, W - 2 * M, 11, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(255, 255, 255);
    doc.text('TOTAL FINAL', M + 3, y + 7.4);
    doc.text(usd(c.total_usd), W - M - 3, y + 7.4, { align: 'right' });
    y += 16;

    doc.setFont('helvetica', 'normal').setFontSize(7.8).setTextColor(...GRIS);
    const nota = doc.splitTextToSize(NOTA_PRECIOS, W - 2 * M) as string[];
    doc.text(nota, M, y);
    y += nota.length * 3.6 + 9;

    // ---- Condiciones comerciales ----
    if (y > H - 75) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(...AZUL_OSCURO);
    doc.text('Condiciones comerciales', M, y);
    autoTable(doc, {
        startY: y + 3,
        margin: { left: M, right: M },
        body: CONDICIONES,
        theme: 'plain',
        styles: { font: 'helvetica', fontSize: 8.8, cellPadding: { top: 2.2, bottom: 2.2, left: 3, right: 3 }, textColor: TEXTO, lineColor: LINEA, lineWidth: { bottom: 0.2 } },
        columnStyles: { 0: { cellWidth: 32, fontStyle: 'bold' } },
        didParseCell: (d) => { if (d.row.index % 2 === 0) d.cell.styles.fillColor = FONDO_ETIQ; },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
    if (y > H - 25) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...TEXTO);
    doc.text(CIERRE, M, y);

    // ---- Pie en todas las páginas ----
    const paginas = doc.getNumberOfPages();
    for (let i = 1; i <= paginas; i++) {
        doc.setPage(i);
        doc.setDrawColor(...AZUL).setLineWidth(0.4).line(M, H - 17, W - M, H - 17);
        doc.setFont('helvetica', 'normal').setFontSize(7.8).setTextColor(...GRIS);
        doc.text(`${EMPRESA.nombre}  -  ${EMPRESA.descripcion}  -  Rosario, Santa Fe`, M, H - 12);
        doc.text(`Página ${i}${paginas > 1 ? ` de ${paginas}` : ''}`, W - M, H - 12, { align: 'right' });
    }

    return { pdf: Buffer.from(doc.output('arraybuffer')), archivo: nombreArchivo(cliente, num) };
}
