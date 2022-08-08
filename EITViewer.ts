
import fs from 'fs';
import { Writable } from 'stream';

import { TsChar, TsDate, TsStream } from "@chinachu/aribts";
import { Command } from 'commander';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';


// 開始時間/番組長未定の場合の生の値
const UNKNOWN_START_TIME = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
const UNKNOWN_DURATION = Buffer.from([0xFF, 0xFF, 0xFF]);

// Python の range 的なもの
// ref: https://gist.github.com/shuding/6b8fb023f63fc8fb4f94
function range(s: number, t: number = 0, a: number = 1) {
    return [...Array(Math.abs(s - t))].map((x, i) => Math.min(s, t) + i * a).filter(x => x < Math.max(s, t));
}

// 虚空に書き込む Writable ストリーム
// ref: https://github.com/dex4er/js-null-writable/blob/master/src/null-writable.ts
class NullWritable extends Writable {
    _write(_chunk: any, _encoding: string, callback: (error?: Error | null) => void): void {
      callback()
    }
    _writev(_chunks: Array<{chunk: any; encoding: string}>, callback: (error?: Error | null) => void): void {
      callback()
    }
}


// タイムゾーンの設定
dayjs.extend(timezone);
dayjs.extend(utc);
dayjs.tz.setDefault('Asia/Tokyo');

// コマンドライン引数の処理
const program = new Command();
program.requiredOption('--input <path>', '入力の TS ファイルのパス');
program.option('--output-log <path>', '出力するログファイルのパス (省略時は stdout に出力)');
program.option('--eit-types <eit_types>', '絞り込む EIT のタイプ (コンマ区切り、present/following/schedule から選択)');
program.option('--service-ids <service_ids>', '絞り込むサービス ID のリスト (コンマ区切り)');
program.option('--event-ids <event_ids>', '絞り込むイベント ID のリスト (コンマ区切り)');
program.parse(process.argv);
const options = program.opts();

// ログの出力先
let logger = console;
if ('outputLog' in options) {
    logger = new console.Console(fs.createWriteStream(options.outputLog));
}

// 絞り込む EIT のタイプ
let filterEitTypes: string[] = [];
if ('eitTypes' in options) {
    filterEitTypes = options.eitTypes.split(',');
}

// 絞り込むサービス ID のリスト
let filterServiceIds: number[] = [];
if ('serviceIds' in options) {
    filterServiceIds = options.serviceIds.split(',').map((value: string) => parseInt(value));
}

// 絞り込むイベント ID のリスト
let filterEventIds: number[] = [];
if ('eventIds' in options) {
    filterEventIds = options.eventIds.split(',').map((value: string) => parseInt(value));
}


// Stream の pipe を開始
// Readable -> Transform (TsStream) -> Writable をつなげて初めて TsStream のイベントが発火する
const readable = fs.createReadStream(options.input);
const writable = new NullWritable();
const tsStream = new TsStream();
readable.pipe(tsStream).pipe(writable);
logger.log('================================================================================');

// EIT を受信したときのイベント
tsStream.on('eit', (pid, eit) => {

    // web-bml いわく、node-aribts 側の問題で CRC が不一致だと変な objEit が送られてきてしまうらしい
    if (eit.events == null) return;

    // 自ストリーム EIT & 自ストリーム EIT[p/f] だけを抽出
    if (!(range(0x50, 0x60).includes(eit.table_id)) && eit.table_id !== 0x4E) return;

    // サービス ID で絞り込み
    if (filterServiceIds.length > 0 && filterServiceIds.includes(eit.service_id) === false) return;

    // EIT のタイプで絞り込み
    let eitType = 'schedule';
    if (eit.table_id === 0x4E) {  // 自ストリーム EIT[p/f]
        eitType = eit.section_number === 0 ? 'present' : 'following';
    }
    if (filterEitTypes.length > 0 && filterEitTypes.includes(eitType) === false) return;

    // Buffer になってるのを TsChar にしたり時刻をフォーマットしたり _raw を消したりいろいろ整形
    const formattedEit = {...eit};
    delete formattedEit._raw;
    let isTargetEventDetected = false;
    for (const event of formattedEit.events) {

        // イベント ID で絞り込み
        if (filterEventIds.length > 0 && filterEventIds.includes(event.event_id) === true) isTargetEventDetected = true;

        // 番組開始時間が未定
        if (UNKNOWN_START_TIME.compare(event.start_time) === 0) {
            event.start_time = Infinity;
        } else {
            event.start_time = dayjs(new TsDate(event.start_time).decode()).local().format();
        }

        // 番組長さが未定
        if (UNKNOWN_DURATION.compare(event.duration) === 0) {
            event.duration = Infinity;
        } else {
            event.duration = new TsDate(event.duration).decodeTime();
            event.duration = event.duration[0] * 3600 + event.duration[1] * 60 + event.duration[2];
        }

        for (const descriptor of event.descriptors) {
            descriptor._raw = null;
            delete descriptor._raw;
            // ISO_639_language_code を文字列にする
            if ('ISO_639_language_code' in descriptor) {
                descriptor.ISO_639_language_code = String.fromCharCode(...descriptor.ISO_639_language_code);
            }
            // text_char を文字列にする
            if ('text_char' in descriptor) {
                descriptor.text_char = new TsChar(descriptor.text_char).decode();
            }
            switch (descriptor.descriptor_tag) {
                // 短形式イベント記述子のみ
                case 0x4D:
                    descriptor.event_name_char = new TsChar(descriptor.event_name_char).decode();
                    break;
                // 拡張形式イベント記述子のみ
                case 0x4E:
                    descriptor.ISO_639_language_code = String.fromCharCode(...descriptor.ISO_639_language_code);
                    for (const item of descriptor.items) {
                        item.item_description_char = new TsChar(item.item_description_char).decode();
                        item.item_char = new TsChar(item.item_char).decode();
                    }
                    break;
            }
        }
    }

    // イベント ID で絞り込みが有効だがイベントそのものが EIT に入ってない
    if (filterEventIds.length > 0 && formattedEit.events.length === 0) return;

    // イベント ID に紐づくイベントをこの EIT の中から見つけられなかった
    if (filterEventIds.length > 0 &&isTargetEventDetected === false) return;

    logger.log(`EIT (Event Information Table) [${eitType}] [service_id: ${eit.service_id}]`);
    logger.log('================================================================================');
    logger.dir(formattedEit, {depth: null});
    logger.log('================================================================================');
});

// TOT を受信したときのイベント
// EIT がどの時刻に送出されたのかを特定する足がかりとして出力
tsStream.on('tot', (pid, tot) => {

    // 時刻情報を MJD から JST に変換し、フォーマット
    const formattedTot = {...tot};
    delete formattedTot._raw;
    formattedTot.JST_time = dayjs(new TsDate(formattedTot.JST_time).decode()).local().format();

    logger.log('TOT (Time Offset Table)');
    logger.log('================================================================================');
    logger.dir(formattedTot, {depth: null});
    logger.log('================================================================================');
});
