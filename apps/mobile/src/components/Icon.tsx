/**
 * Icon — ícones de UI em react-native-svg (stroke, estilo "feather/lucide").
 * Uso: <Icon name="home" size={22} color={theme.text} />
 */
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'home' | 'grid' | 'play' | 'bell' | 'settings'
  | 'mail' | 'lock' | 'eye'
  | 'chevronLeft' | 'chevronRight' | 'chevronDown'
  | 'camera' | 'mic' | 'volume' | 'volumeOff' | 'expand'
  | 'plus' | 'minus' | 'crosshair'
  | 'arrowUp' | 'arrowDown' | 'arrowLeft' | 'arrowRight'
  | 'download' | 'check' | 'server' | 'logout' | 'cloud' | 'smartphone' | 'info' | 'share'
  | 'alert' | 'moon' | 'sun' | 'videoOff' | 'aperture' | 'maximize'
  | 'star' | 'edit' | 'trash' | 'close' | 'clock'
  | 'pause' | 'rewind' | 'forward'
  | 'wifi' | 'bluetooth' | 'qrCode' | 'search' | 'cable' | 'radio';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  fill?: boolean; // alguns ícones (play) são preenchidos
}

export function Icon({ name, size = 22, color = '#fff', strokeWidth = 1.9, fill = false }: IconProps) {
  const stroke = fill ? 'none' : color;
  const fillColor = fill ? color : 'none';
  const common = {
    stroke,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  switch (name) {
    case 'home':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M3 10.6 12 3.2l9 7.4" />
          <Path {...common} d="M5.2 9.3V20.4h13.6V9.3" />
        </Svg>
      );
    case 'grid':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={3} width={7.3} height={7.3} rx={2} />
          <Rect {...common} x={13.7} y={3} width={7.3} height={7.3} rx={2} />
          <Rect {...common} x={3} y={13.7} width={7.3} height={7.3} rx={2} />
          <Rect {...common} x={13.7} y={13.7} width={7.3} height={7.3} rx={2} />
        </Svg>
      );
    case 'play':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path fill={color} d="M8 5.2c0-.8.9-1.3 1.6-.9l9.2 6.3c.6.4.6 1.4 0 1.8l-9.2 6.3c-.7.4-1.6 0-1.6-.9z" />
        </Svg>
      );
    case 'bell':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M6 9.5a6 6 0 0 1 12 0c0 5.5 2 7 2 7H4s2-1.5 2-7" />
          <Path {...common} d="M10 20a2 2 0 0 0 4 0" />
        </Svg>
      );
    case 'settings':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={3.1} />
          <Path {...common} d="M12 2.5v2.4M12 19.1v2.4M4.4 4.4l1.7 1.7M17.9 17.9l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.4 19.6l1.7-1.7M17.9 6.1l1.7-1.7" />
        </Svg>
      );
    case 'mail':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={5} width={18} height={14} rx={3} />
          <Path {...common} d="m3.5 7 8.5 6 8.5-6" />
        </Svg>
      );
    case 'lock':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={4} y={10} width={16} height={11} rx={3} />
          <Path {...common} d="M8 10V7.5a4 4 0 0 1 8 0V10" />
        </Svg>
      );
    case 'eye':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
          <Circle {...common} cx={12} cy={12} r={2.6} />
        </Svg>
      );
    case 'chevronLeft':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M15 5l-7 7 7 7" /></Svg>);
    case 'chevronRight':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M9 5l7 7-7 7" /></Svg>);
    case 'chevronDown':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.1} d="M6 9l6 6 6-6" /></Svg>);
    case 'camera':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={6} width={18} height={13} rx={3} />
          <Circle {...common} cx={12} cy={12.5} r={3.4} />
          <Path {...common} d="M8 6l1.3-2h5.4L16 6" />
        </Svg>
      );
    case 'mic':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={9} y={3} width={6} height={11} rx={3} />
          <Path {...common} d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </Svg>
      );
    case 'volume':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M4 9v6h4l5 4V5L8 9z" />
          <Path {...common} d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
        </Svg>
      );
    case 'volumeOff':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6" /></Svg>);
    case 'expand':
    case 'maximize':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>);
    case 'plus':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.5} d="M12 5v14M5 12h14" /></Svg>);
    case 'minus':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.5} d="M5 12h14" /></Svg>);
    case 'crosshair':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={3} />
          <Path {...common} d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </Svg>
      );
    case 'arrowUp':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M12 19V6M6 11l6-6 6 6" /></Svg>);
    case 'arrowDown':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M12 5v13M6 13l6 6 6-6" /></Svg>);
    case 'arrowLeft':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M19 12H6M11 6l-6 6 6 6" /></Svg>);
    case 'arrowRight':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M5 12h13M13 6l6 6-6 6" /></Svg>);
    case 'download':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} d="M12 3v12M7 11l5 5 5-5M5 20h14" /></Svg>);
    case 'check':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M20 6L9 17l-5-5" /></Svg>);
    case 'server':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={4} width={18} height={7} rx={2} />
          <Rect {...common} x={3} y={13} width={18} height={7} rx={2} />
          <Path {...common} d="M7 7.5h.01M7 16.5h.01" />
        </Svg>
      );
    case 'logout':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>);
    case 'cloud':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} d="M5 15.5a4.5 4.5 0 0 1 .8-8.9 5.5 5.5 0 0 1 10.5 1.3A3.8 3.8 0 0 1 18 15.4z" /></Svg>);
    case 'smartphone':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect {...common} x={6} y={2.5} width={12} height={19} rx={3} /><Path {...common} d="M11 18.5h2" /></Svg>);
    case 'info':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Circle {...common} cx={12} cy={12} r={9} /><Path {...common} d="M12 16v-4M12 8h.01" /></Svg>);
    case 'share':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Circle {...common} cx={6} cy={12} r={2.6} /><Circle {...common} cx={17.5} cy={5.5} r={2.6} /><Circle {...common} cx={17.5} cy={18.5} r={2.6} /><Path {...common} d="m8.4 10.8 6.8-4M8.4 13.2l6.8 4" /></Svg>);
    case 'alert':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.1} d="M12 3.5 21 19H3z" /><Path {...common} strokeWidth={strokeWidth + 0.1} d="M12 10v4M12 17h.01" /></Svg>);
    case 'moon':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Svg>);
    case 'sun':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={4.5} />
          <Path {...common} d="M12 1.5v2.5M12 20v2.5M3.5 12H1M23 12h-2.5M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5" />
        </Svg>
      );
    case 'videoOff':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M2 2l20 20" />
          <Path {...common} d="M6.7 6.7C4.6 7.6 3 9 3 9v9.5A1.5 1.5 0 0 0 4.5 20h13" />
          <Path {...common} d="M9.5 5h6l1.4 2H19.5A1.5 1.5 0 0 1 21 8.5v8" />
        </Svg>
      );
    case 'aperture':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={3.4} />
          <Path {...common} d="M3 8.2V6.5A1.5 1.5 0 0 1 4.5 5h2.2l1.4-2h7.8l1.4 2h2.2A1.5 1.5 0 0 1 21 6.5v11A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5" />
        </Svg>
      );
    case 'star':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} fill={fill ? color : 'none'} strokeLinejoin="round" d="M12 3.2l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.4 9.3l5.8-.8z" />
        </Svg>
      );
    case 'edit':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M12 20h9" />
          <Path {...common} d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </Svg>
      );
    case 'trash':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
        </Svg>
      );
    case 'clock':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={9} />
          <Path {...common} d="M12 7.5V12l3 2" />
        </Svg>
      );
    case 'wifi':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M3 8.7a14 14 0 0 1 18 0M6.5 12.2a8.8 8.8 0 0 1 11 0M9.8 15.6a3.8 3.8 0 0 1 4.4 0" />
          <Circle cx={12} cy={19} r={1.1} fill={color} />
        </Svg>
      );
    case 'bluetooth':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M7 7l10 10-5 4V3l5 4L7 17" />
        </Svg>
      );
    case 'qrCode':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={3} width={7} height={7} rx={1} />
          <Rect {...common} x={14} y={3} width={7} height={7} rx={1} />
          <Rect {...common} x={3} y={14} width={7} height={7} rx={1} />
          <Path {...common} d="M14 14h3v3h4M14 21v-3M18 21h3" />
        </Svg>
      );
    case 'search':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={10.5} cy={10.5} r={6.5} />
          <Path {...common} d="m15.4 15.4 5 5" />
        </Svg>
      );
    case 'cable':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path {...common} d="M7 3v5M11 3v5M5 8h8v2a4 4 0 0 1-4 4v2a5 5 0 0 0 5 5h1" />
          <Path {...common} d="M15 18h5v3h-5z" />
        </Svg>
      );
    case 'radio':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={2} />
          <Path {...common} d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
        </Svg>
      );
    case 'close':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path {...common} strokeWidth={strokeWidth + 0.3} d="M6 6l12 12M18 6L6 18" /></Svg>);
    case 'pause':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x={6} y={4.5} width={4} height={15} rx={1.3} fill={color} />
          <Rect x={14} y={4.5} width={4} height={15} rx={1.3} fill={color} />
        </Svg>
      );
    case 'rewind':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path fill={color} d="M11.4 5.3c.5-.4 1.3 0 1.3.7v12c0 .7-.8 1.1-1.3.7l-7.2-6a.9.9 0 0 1 0-1.4z" />
          <Path fill={color} d="M20.4 5.3c.5-.4 1.3 0 1.3.7v12c0 .7-.8 1.1-1.3.7l-7.2-6a.9.9 0 0 1 0-1.4z" />
        </Svg>
      );
    case 'forward':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path fill={color} d="M12.6 5.3c-.5-.4-1.3 0-1.3.7v12c0 .7.8 1.1 1.3.7l7.2-6a.9.9 0 0 0 0-1.4z" />
          <Path fill={color} d="M3.6 5.3c-.5-.4-1.3 0-1.3.7v12c0 .7.8 1.1 1.3.7l7.2-6a.9.9 0 0 0 0-1.4z" />
        </Svg>
      );
    default:
      return null;
  }
}
