// Datos de Bartez para el PDF de presupuesto (tomados del presupuesto modelo).
export const EMPRESA = {
    nombre: 'Bartez Tecnología',
    descripcion: 'Distribuidor mayorista de IT',
    titular: 'Andres Benitez',
    cuit: '20-21774424-6',
    direccion: '9 de Julio 3418, Rosario, Santa Fe',
    telefono: '341-5104902',
    web: 'bartez.com.ar',
};

// Nota debajo del total.
export const NOTA_PRECIOS =
    'Precio expresado en dólares estadounidenses (USD billete BNA). El tipo de cambio se fija al día del pago.';

// Condiciones comerciales al pie del presupuesto.
export const CONDICIONES: Array<[string, string]> = [
    ['Forma de pago', 'Transferencia bancaria. La mercadería se despacha una vez acreditado el pago, contra factura.'],
    ['Entrega', 'Retiro en 9 de Julio 3418, Rosario, o envío a coordinar. 24 a 72 hs hábiles, sujeto a stock.'],
    ['Facturación', 'Andres Benitez - Responsable Inscripto. Factura A con IVA discriminado.'],
    ['Retenciones', 'En caso de aplicar retenciones (IVA, Ganancias, IIBB, SUSS), informar previo a la emisión de la factura.'],
    ['Garantía', 'Garantía oficial del fabricante / distribuidor.'],
    ['Validez', '7 días corridos desde la fecha de emisión, sujeto a disponibilidad y cotización vigente.'],
];

export const CIERRE = 'Quedamos a disposición para cualquier consulta técnica o comercial.';
