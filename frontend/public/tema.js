// El tema elegido se aplica antes de pintar: si elegiste claro con el sistema en
// oscuro (o al revés), no parpadea el otro al cargar.
try {
    var tema = localStorage.getItem('bartez_tema');
    if (tema === 'claro' || tema === 'oscuro') document.documentElement.dataset.theme = tema === 'claro' ? 'light' : 'dark';
} catch (e) { /* sin storage: sigue al sistema */ }
