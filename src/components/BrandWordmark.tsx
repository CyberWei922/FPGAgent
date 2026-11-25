import { useId } from 'react';

interface BrandWordmarkProps {
  className?: string;
}

export function BrandWordmark({ className }: BrandWordmarkProps) {
  const uid = useId().replace(/:/g, '');
  const aId = `${uid}-a`;
  const cutId = `${uid}-cut`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="2 4 156 34"
      fill="none"
      role="img"
      aria-label="FPGAgent"
      className={className ? `brand-wordmark ${className}` : 'brand-wordmark'}
    >
      <defs>
        <path
          id={aId}
          fillRule="evenodd"
          d="M8.4 6H12L20.4 30H16.3L14.6 24.8H5.8L4.1 30H0L8.4 6ZM10.2 11.2L6.9 21.4H13.5L10.2 11.2Z"
        />
        <mask id={cutId}>
          <rect x="-20" y="-10" width="210" height="60" fill="#ffffff" />
          <use
            href={`#${aId}`}
            x="61.5"
            fill="#000000"
            stroke="#000000"
            strokeWidth="2.6"
            strokeLinejoin="miter"
          />
        </mask>
      </defs>
      <g transform="translate(7,0) skewX(-10)">
        <g fill="currentColor">
          <path transform="translate(2,0)" d="M0 6H15V9.6H3.8V16.2H12.6V19.6H3.8V30H0V6Z" />
          <path
            transform="translate(20.5,0)"
            fillRule="evenodd"
            d="M0 6H12.8L16.5 9.6V16.8L12.8 20.4H3.8V30H0V6ZM3.8 9.6H11.4L12.8 11V15.4L11.4 16.8H3.8V9.6Z"
          />
          <path
            transform="translate(40.5,0)"
            d="M4 6H14.5L18 9.5V12.2H14.2V10.8L13 9.6H5.2L3.8 11V25L5.2 26.4H13.2L14.4 25.2V20.4H10V17H18V26.5L14.5 30H4L0 26V10L4 6Z"
          />
        </g>
        <use href={`#${aId}`} x="68.0" fill="#76B900" mask={`url(#${cutId})`} />
        <use href={`#${aId}`} x="61.5" fill="currentColor" />
        <g fill="currentColor">
          <path
            transform="translate(87.5,0)"
            fillRule="evenodd"
            d="M6.5 13C8.7 13 10.3 13.8 11.4 15.2V13.4H14.5V31.6C14.5 34.7 12.1 36.5 7.9 36.5C4.8 36.5 2.4 35.5 1.1 33.8L3.4 31.8C4.4 33 5.9 33.6 7.8 33.6C10.2 33.6 11.4 32.6 11.4 30.8V27.7C10.3 29.1 8.7 29.9 6.5 29.9C2.6 29.9 0 26.8 0 21.45C0 16.1 2.6 13 6.5 13ZM7.3 15.9C4.7 15.9 3.2 18 3.2 21.45C3.2 24.9 4.7 27 7.3 27C9.9 27 11.4 24.9 11.4 21.45C11.4 18 9.9 15.9 7.3 15.9Z"
          />
          <path
            transform="translate(105.2,0)"
            fillRule="evenodd"
            d="M7.4 13C11.8 13 14.4 16 14.4 20.9V22.5H3.2C3.5 25.4 5.2 27.1 7.9 27.1C9.8 27.1 11.2 26.3 12.1 25.1L14.2 27C12.8 28.9 10.6 30 7.7 30C2.9 30 0 26.8 0 21.5C0 16.2 2.9 13 7.4 13ZM3.3 19.9H11.2C11 17.3 9.5 15.8 7.4 15.8C5.2 15.8 3.7 17.3 3.3 19.9Z"
          />
          <path
            transform="translate(122.8,0)"
            d="M0 13.4H3.1V15.7C4.2 14 5.9 13 8.1 13C11.6 13 13.8 15.2 13.8 19.1V30H10.6V19.6C10.6 17.2 9.4 15.9 7.3 15.9C4.8 15.9 3.2 17.5 3.2 20.1V30H0V13.4Z"
          />
          <path
            transform="translate(139.4,0)"
            d="M2.8 8.4H6V13.4H10V16.2H6V24.9C6 26.5 6.8 27.2 8.4 27.2H10.2V29.9H7.7C4.4 29.9 2.8 28.3 2.8 25V16.2H0V13.4H2.8V8.4Z"
          />
        </g>
      </g>
    </svg>
  );
}
