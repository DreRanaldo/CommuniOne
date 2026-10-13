import { Text, type TextProps } from '@/components';
import { makeStyles } from '@/theme';

const HASHTAG = /(#[\p{L}\p{N}_]+)/gu;

/** Splits text into plain and #hashtag parts (display only: hashtags are not links yet). */
export function splitHashtags(body: string): { text: string; tag: boolean }[] {
  return body
    .split(HASHTAG)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, tag: /^#[\p{L}\p{N}_]+$/u.test(part) }));
}

/** A post's text, with #hashtags highlighted. */
export function PostBody({ body, ...rest }: { body: string } & Omit<TextProps, 'children'>) {
  const styles = useStyles();
  const parts = splitHashtags(body);
  if (!parts.some((p) => p.tag)) return <Text {...rest}>{body}</Text>;
  return (
    <Text {...rest}>
      {parts.map((part, i) =>
        part.tag ? (
          <Text key={i} style={styles.tag}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

const useStyles = makeStyles((t) => ({
  tag: { color: t.colors.primary, fontWeight: '600' },
}));
