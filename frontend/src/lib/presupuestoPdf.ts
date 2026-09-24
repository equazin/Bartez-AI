// Genera el PDF de presupuesto para el cliente a partir de una cotización.
// Solo incluye lo que ve el cliente: nunca proveedor, SKU del mayorista, costo
// ni alternativas. Se carga bajo demanda para no agrandar la app.

import type { Cotizacion } from '../api/client.ts';
import { CONDICIONES, EMPRESA } from '../config/empresa.ts';

const usd = (n: number) => `USD ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ars = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function numeroPresupuesto(c: Cotizacion): string {
    const fecha = c.creado_en ? new Date(c.creado_en) : new Date();
    const aammdd = fecha.toISOString().slice(2, 10).replace(/-/g, '');
    return `${aammdd}-${(c.id ?? 'borrador').slice(0, 4).toUpperCase()}`;
}

function nombreArchivo(c: Cotizacion): string {
    const base = (c.titulo || 'cliente').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return `presupuesto-bartez-${base || 'cliente'}-${numeroPresupuesto(c)}.pdf`;
}

export async function descargarPresupuestoPdf(c: Cotizacion, opts: { cliente?: string; conPesos?: boolean } = {}): Promise<void> {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const ancho = doc.internal.pageSize.getWidth();
    const M = 15;
    const acento: [number, number, number] = [47, 111, 237];

    // Encabezado: empresa a la izquierda, datos del presupuesto a la derecha.
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(23, 26, 36);
    doc.text(EMPRESA.nombre, M, 22);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(106, 114, 128);
    const datosEmpresa = [
        EMPRESA.cuit && `CUIT ${EMPRESA.cuit}`,
        EMPRESA.direccion,
        [EMPRESA.telefono, EMPRESA.email].filter(Boolean).join(' · '),
        EMPRESA.web,
    ].filter(Boolean) as string[];
    datosEmpresa.forEach((l, i) => doc.text(l, M, 28 + i * 4.5));

    const fecha = c.creado_en ? new Date(c.creado_en) : new Date();
    doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(...acento);
    doc.text('PRESUPUESTO', ancho - M, 22, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(23, 26, 36);
    doc.text(`N° ${numeroPresupuesto(c)}`, ancho - M, 28, { align: 'right' });
    doc.text(`Fecha: ${fecha.toLocaleDateString('es-AR')}`, ancho - M, 32.5, { align: 'right' });

    let y = 30 + datosEmpresa.length * 4.5 + 4;
    doc.setDrawColor(223, 227, 236).line(M, y, ancho - M, y);
    y += 7;
    const cliente = (opts.cliente ?? c.titulo ?? '').trim();
    if (cliente) {
        doc.setFont('helvetica', 'bold').setFontSize(10).text('Cliente:', M, y);
        doc.setFont('helvetica', 'normal').text(cliente, M + 16, y);
        y += 7;
    }

    // Renglones: solo los que tienen artículo elegido.
    const lineas = c.lineas.filter((l) => l.elegido);
    autoTable(doc, {
        startY: y,
        margin: { left: M, right: M },
        head: [['#', 'Descripción', 'Cant.', 'Precio unit.', 'IVA', 'Subtotal']],
        body: lineas.map((l, i) => {
            const e = l.elegido!;
            // "NB" es la abreviatura de Air: al cliente se le muestra "Notebook".
            const base = e.descripcion.replace(/^NB\b/i, 'Notebook');
            const desc = e.marca && !base.toUpperCase().includes(e.marca.toUpperCase()) ? `${e.marca} ${base}` : base;
            const iva = `${e.iva_pct.toLocaleString('es-AR')}%`;
            return [String(i + 1), desc, String(l.cantidad), usd(e.precio_unit_usd), iva, usd(e.precio_unit_usd * l.cantidad)];
        }),
        styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 2, textColor: [23, 26, 36], lineColor: [223, 227, 236], lineWidth: 0.1 },
        headStyles: { fillColor: acento, textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [246, 247, 250] },
        columnStyles: {
            0: { cellWidth: 8, halign: 'center' },
            2: { cellWidth: 14, halign: 'center' },
            3: { cellWidth: 28, halign: 'right' },
            4: { cellWidth: 14, halign: 'center' },
            5: { cellWidth: 30, halign: 'right' },
        },
    });

    // Totales.
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
    if (y > 250) { doc.addPage(); y = 20; }
    const filaTotal = (etq: string, val: string, fuerte = false) => {
        doc.setFont('helvetica', fuerte ? 'bold' : 'normal').setFontSize(fuerte ? 11 : 9.5);
        doc.text(etq, ancho - M - 45, y, { align: 'right' });
        doc.text(val, ancho - M, y, { align: 'right' });
        y += fuerte ? 7 : 5.5;
    };
    filaTotal('Subtotal', usd(c.subtotal_usd));
    filaTotal('IVA', usd(c.iva_usd));
    doc.setDrawColor(223, 227, 236).line(ancho - M - 80, y - 3.5, ancho - M, y - 3.5);
    filaTotal('Total', usd(c.total_usd), true);
    if (opts.conPesos !== false && c.tipo_cambio > 0) {
        doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(106, 114, 128);
        doc.text(`Equivalente en pesos: ${ars(c.total_ars)} (TC ${c.tipo_cambio.toLocaleString('es-AR')} al ${fecha.toLocaleDateString('es-AR')})`, ancho - M, y, { align: 'right' });
        doc.setTextColor(23, 26, 36);
        y += 8;
    }

    // Condiciones.
    y += 4;
    if (y > 265) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold').setFontSize(9).text('Condiciones', M, y);
    y += 5;
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(106, 114, 128);
    for (const cond of CONDICIONES) {
        const partes = doc.splitTextToSize(`• ${cond}`, ancho - 2 * M) as string[];
        doc.text(partes, M, y);
        y += partes.length * 4.2;
    }

    // Pie en todas las páginas.
    const paginas = doc.getNumberOfPages();
    for (let i = 1; i <= paginas; i++) {
        doc.setPage(i);
        doc.setFontSize(7.5).setTextColor(150, 155, 165);
        doc.text(`${EMPRESA.nombre} · ${EMPRESA.web}`, M, 290);
        doc.text(`Página ${i} de ${paginas}`, ancho - M, 290, { align: 'right' });
    }

    doc.save(nombreArchivo(c));
}
