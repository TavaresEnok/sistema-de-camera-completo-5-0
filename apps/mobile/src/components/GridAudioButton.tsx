import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { useTheme } from '../theme/ThemeProvider';

export function GridAudioButton({ name, selected, loading, onPress }: {
  name: string; selected: boolean; loading: boolean; onPress: () => void;
}) {
  const { theme } = useTheme();
  return <Pressable accessibilityRole="button"
    accessibilityLabel={`${selected ? 'Desligar' : 'Ligar'} áudio de ${name}`}
    accessibilityHint={loading ? 'Preparando o som. Toque para cancelar.' : undefined}
    accessibilityState={{ selected, busy: loading }}
    onPress={event => { event.stopPropagation(); onPress(); }}
    style={[styles.button, { backgroundColor: selected ? theme.accent : 'rgba(0,0,0,0.72)' }]}>
    {loading ? <ActivityIndicator color={theme.textOnAccent} size="small" /> : <Icon name={selected ? 'volume' : 'volumeOff'} size={19} color={selected ? theme.textOnAccent : '#fff'} />}
  </Pressable>;
}
const styles = StyleSheet.create({ button: { position: 'absolute', right: 6, bottom: 38, zIndex: 10, width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' } });
