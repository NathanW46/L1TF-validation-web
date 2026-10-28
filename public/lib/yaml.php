<?php
// YAML subset parser — a line-by-line port of the parser in
// contrib/check_analysis.py. Keep the two identical: tests/run_tests.sh runs
// both against tests/yaml_fixtures/ and fails if they disagree.
//
// Supported: "key: value" maps, nested by indentation (spaces only);
// "- item" lists, including lists of maps; # comments; "double" and
// 'single' quoted strings; inline lists [a, b]; block text with > (folded)
// or | (literal), optionally >- / |-. Plain values stay strings; ~ and null
// become null. Anything else throws YamlError("line N: ...").

class YamlError extends Exception {}

// A parsed map. Plain PHP arrays can't tell {"0": x} from the list [x], so
// maps are wrapped to always encode as JSON objects. Reads work like an array
// ($m['key'], isset, ??, foreach, count).
class YamlMap implements ArrayAccess, IteratorAggregate, Countable, JsonSerializable
{
    private $data;

    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public function toArray()
    {
        return $this->data;
    }

    #[\ReturnTypeWillChange]
    public function offsetExists($k)
    {
        return array_key_exists($k, $this->data) && $this->data[$k] !== null;
    }

    #[\ReturnTypeWillChange]
    public function offsetGet($k)
    {
        return array_key_exists($k, $this->data) ? $this->data[$k] : null;
    }

    #[\ReturnTypeWillChange]
    public function offsetSet($k, $v)
    {
        throw new LogicException('YamlMap is read-only');
    }

    #[\ReturnTypeWillChange]
    public function offsetUnset($k)
    {
        throw new LogicException('YamlMap is read-only');
    }

    #[\ReturnTypeWillChange]
    public function getIterator()
    {
        return new ArrayIterator($this->data);
    }

    #[\ReturnTypeWillChange]
    public function count()
    {
        return count($this->data);
    }

    #[\ReturnTypeWillChange]
    public function jsonSerialize()
    {
        return (object)$this->data;
    }
}

class YamlSubsetParser
{
    const KEY_BAD_START = "'\"[]{},&*!|>%@#`";
    private static $ESCAPES = ['"' => '"', '\\' => '\\', '/' => '/', 'n' => "\n", 't' => "\t"];

    private $lines;
    private $n;
    private $i = 0;

    public function __construct($text)
    {
        $text = str_replace(["\r\n", "\r"], "\n", $text);
        if (substr($text, 0, 3) === "\xEF\xBB\xBF") {
            $text = substr($text, 3);
        }
        $this->lines = explode("\n", $text);
        $this->n = count($this->lines);
    }

    private function err($i, $msg)
    {
        throw new YamlError('line ' . ($i + 1) . ': ' . $msg);
    }

    private static function isItem($content)
    {
        return $content === '-' || strncmp($content, '- ', 2) === 0;
    }

    private function indent($i)
    {
        $line = $this->lines[$i];
        $len = strlen($line);
        $k = 0;
        while ($k < $len && $line[$k] === ' ') {
            $k++;
        }
        if ($k < $len && $line[$k] === "\t") {
            $this->err($i, 'tabs are not allowed for indentation');
        }
        return $k;
    }

    private function skip($i)
    {
        while ($i < $this->n) {
            $s = trim($this->lines[$i]);
            if ($s !== '' && $s[0] !== '#') {
                return $i;
            }
            $i++;
        }
        return $i;
    }

    public function parse()
    {
        $i = $this->skip(0);
        if ($i < $this->n && trim($this->lines[$i]) === '---') {
            $i = $this->skip($i + 1);
        }
        if ($i >= $this->n) {
            return new YamlMap([]);
        }
        if ($this->indent($i) !== 0) {
            $this->err($i, 'unexpected indentation');
        }
        if (self::isItem(trim($this->lines[$i]))) {
            $this->err($i, "the top level must be 'key: value' lines");
        }
        $this->i = $i;
        $result = $this->parseMap(0, []);
        $i = $this->skip($this->i);
        if ($i < $this->n) {
            $this->err($i, 'unexpected indentation');
        }
        return $result;
    }

    private function block($ind)
    {
        $content = (string)substr($this->lines[$this->i], $ind);
        if (self::isItem($content)) {
            return $this->parseList($ind);
        }
        return $this->parseMap($ind, []);
    }

    // [key, rest] if content looks like 'key: value', else null. The key
    // ends at the first ':' followed by a space, tab or end of line.
    private static function findKey($content)
    {
        $len = strlen($content);
        for ($k = 0; $k < $len; $k++) {
            if ($content[$k] === ':' && ($k + 1 === $len || $content[$k + 1] === ' ' || $content[$k + 1] === "\t")) {
                $key = trim(substr($content, 0, $k));
                if ($key === '' || strpos(self::KEY_BAD_START, $key[0]) !== false
                        || strncmp($key, '- ', 2) === 0) {
                    return null;
                }
                return [$key, (string)substr($content, $k + 1)];
            }
        }
        return null;
    }

    private function splitKey($i, $content)
    {
        $kv = self::findKey($content);
        if ($kv === null) {
            $this->err($i, "expected 'key: value'");
        }
        return $kv;
    }

    private function parseMap($ind, $result)
    {
        while (true) {
            $i = $this->skip($this->i);
            if ($i >= $this->n) {
                break;
            }
            $li = $this->indent($i);
            if ($li < $ind) {
                break;
            }
            if ($li > $ind) {
                $this->err($i, 'unexpected indentation');
            }
            $content = (string)substr($this->lines[$i], $li);
            if (self::isItem($content)) {
                break;   // a list at the parent key's indentation ends here
            }
            list($key, $rest) = $this->splitKey($i, $content);
            if (array_key_exists($key, $result)) {
                $this->err($i, "duplicate key '$key'");
            }
            $this->i = $i + 1;
            $result[$key] = $this->value($rest, $ind, $i);
        }
        return new YamlMap($result);
    }

    private function parseList($ind)
    {
        $result = [];
        while (true) {
            $i = $this->skip($this->i);
            if ($i >= $this->n) {
                break;
            }
            $li = $this->indent($i);
            if ($li < $ind) {
                break;
            }
            if ($li > $ind) {
                $this->err($i, 'unexpected indentation');
            }
            $content = (string)substr($this->lines[$i], $li);
            if (!self::isItem($content)) {
                break;
            }
            $this->i = $i + 1;
            $after = (string)substr($content, 1);
            $item = ltrim($after, ' ');
            $col = $li + 1 + (strlen($after) - strlen($item));
            if (self::isItem($item)) {
                $this->err($i, "nested '- -' list items are not supported");
            }
            if (self::findKey($item) !== null) {
                list($key, $rest) = $this->splitKey($i, $item);
                $m = [$key => $this->value($rest, $col, $i)];
                $result[] = $this->parseMap($col, $m);
            } else {
                $result[] = $this->value($item, $ind, $i);
            }
        }
        return $result;
    }

    // The value after 'key:' or '- ' on line i (ind = that line's indentation).
    private function value($rest, $ind, $i)
    {
        list($kind, $val) = $this->scalar($rest, $i);
        if ($kind === 'empty') {
            $j = $this->skip($this->i);
            if ($j < $this->n) {
                $lj = $this->indent($j);
                $cj = (string)substr($this->lines[$j], $lj);
                if ($lj > $ind || ($lj === $ind && self::isItem($cj))) {
                    $this->i = $j;
                    return $this->block($lj);
                }
            }
            return null;
        }
        if ($kind === 'block') {
            return $this->blockText($val, $ind);
        }
        return $val;
    }

    // ['empty'|'block'|'value', value] for the text of one value.
    private function scalar($s, $i)
    {
        $s = trim($s);
        if ($s === '') {
            return ['empty', null];
        }
        $c = $s[0];
        if ($c === '"' || $c === "'") {
            list($val, $end) = $this->quoted($s, 0, $i);
            $this->checkTail((string)substr($s, $end), $i, 'unexpected text after quoted string');
            return ['value', $val];
        }
        if ($c === '[') {
            return ['value', $this->inlineList($s, $i)];
        }
        if ($c === '{') {
            $this->err($i, 'inline maps {...} are not supported');
        }
        if (strpos('&*!%@`', $c) !== false) {
            $this->err($i, "'$c' at the start of a value is not supported (put the value in quotes)");
        }
        // plain: a comment starts at '#' preceded by whitespace
        if (preg_match('/(^|[ \t])#/', $s, $m, PREG_OFFSET_CAPTURE)) {
            $s = rtrim(substr($s, 0, $m[0][1]));
        }
        if ($s === '') {
            return ['empty', null];
        }
        if (in_array($s, ['>', '|', '>-', '|-'], true)) {
            return ['block', $s];
        }
        if ($s === '~' || $s === 'null') {
            return ['value', null];
        }
        return ['value', $s];
    }

    private function checkTail($tail, $i, $msg)
    {
        $tail = trim($tail);
        if ($tail !== '' && $tail[0] !== '#') {
            $this->err($i, $msg);
        }
    }

    // Parse the quoted string starting at s[k]; returns [value, index after
    // the closing quote].
    private function quoted($s, $k, $i)
    {
        $q = $s[$k];
        $out = '';
        $len = strlen($s);
        $k++;
        while ($k < $len) {
            $c = $s[$k];
            if ($q === "'" && $c === "'") {
                if ($k + 1 < $len && $s[$k + 1] === "'") {
                    $out .= "'";
                    $k += 2;
                    continue;
                }
                return [$out, $k + 1];
            }
            if ($q === '"' && $c === '\\') {
                if ($k + 1 >= $len) {
                    break;
                }
                $e = $s[$k + 1];
                if (!array_key_exists($e, self::$ESCAPES)) {
                    $this->err($i, "unsupported escape '\\$e'");
                }
                $out .= self::$ESCAPES[$e];
                $k += 2;
                continue;
            }
            if ($q === '"' && $c === '"') {
                return [$out, $k + 1];
            }
            $out .= $c;
            $k++;
        }
        $this->err($i, 'unterminated quoted string');
    }

    private function inlineList($s, $i)
    {
        $items = [];
        $len = strlen($s);
        $k = 1;
        while (true) {
            while ($k < $len && ($s[$k] === ' ' || $s[$k] === "\t")) {
                $k++;
            }
            if ($k >= $len) {
                $this->err($i, "unterminated list '['");
            }
            $c = $s[$k];
            if ($c === ']' && !$items) {
                $k++;
                break;
            }
            if ($c === '"' || $c === "'") {
                list($val, $k) = $this->quoted($s, $k, $i);
            } elseif ($c === '[') {
                $this->err($i, 'nested lists [...] are not supported');
            } elseif ($c === '{') {
                $this->err($i, 'inline maps {...} are not supported');
            } else {
                $start = $k;
                while ($k < $len && $s[$k] !== ',' && $s[$k] !== ']') {
                    $k++;
                }
                $val = trim(substr($s, $start, $k - $start));
                if ($val === '~' || $val === 'null') {
                    $val = null;
                }
            }
            $items[] = $val;
            while ($k < $len && ($s[$k] === ' ' || $s[$k] === "\t")) {
                $k++;
            }
            if ($k >= $len) {
                $this->err($i, "unterminated list '['");
            }
            if ($s[$k] === ',') {
                $k++;
                continue;
            }
            if ($s[$k] === ']') {
                $k++;
                break;
            }
            $this->err($i, "expected ',' or ']' in list");
        }
        $this->checkTail((string)substr($s, $k), $i, 'unexpected text after list');
        return $items;
    }

    private function blockText($style, $ind)
    {
        $out = [];
        $i = $this->i;
        $blockInd = null;
        while ($i < $this->n) {
            $raw = $this->lines[$i];
            if (trim($raw) === '') {
                $out[] = '';
                $i++;
                continue;
            }
            $li = strlen($raw) - strlen(ltrim($raw, ' '));
            if ($li <= $ind) {
                break;
            }
            if ($blockInd === null) {
                $blockInd = $li;
            } elseif ($li < $blockInd) {
                $this->err($i, 'block text is less indented than its first line');
            }
            $out[] = (string)substr($raw, $blockInd);
            $i++;
        }
        $this->i = $i;
        while ($out && end($out) === '') {
            array_pop($out);
        }
        if ($style[0] === '|') {
            $text = implode("\n", $out);
        } else {
            $text = '';
            foreach ($out as $line) {
                if ($line === '') {
                    $text .= "\n";
                } else {
                    if ($text !== '' && substr($text, -1) !== "\n") {
                        $text .= ' ';
                    }
                    $text .= $line;
                }
            }
        }
        if ($text !== '' && substr($style, -1) !== '-') {
            $text .= "\n";
        }
        return $text;
    }
}

function parse_yaml_subset($text)
{
    $p = new YamlSubsetParser($text);
    return $p->parse();
}
