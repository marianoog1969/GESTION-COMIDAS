/** Logotipo de la aplicación (el mismo dibujo que el icono del programa). */
export default function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Comida de celebración">
      <defs>
        <linearGradient id="lg-fondo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2e6ee6" />
          <stop offset="1" stopColor="#184082" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#lg-fondo)" />
      <rect x="18" y="7.5" width="28" height="47" rx="5.2" fill="#fff" />
      <rect x="20" y="11" width="24" height="40" rx="2.8" fill="#e8f0fe" />
      <circle cx="32" cy="28" r="8.9" fill="#1f8e5a" />
      <text x="32" y="28.6" textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="700" fill="#fff" fontFamily="'Segoe UI', Arial, sans-serif">€</text>
      <rect x="23.2" y="41" width="17.5" height="1.8" rx="0.9" fill="#a0b6d8" />
      <rect x="23.2" y="44.5" width="12.5" height="1.8" rx="0.9" fill="#bccce2" />
    </svg>
  );
}
