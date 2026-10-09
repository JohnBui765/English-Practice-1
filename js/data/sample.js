// Sample content for first-run "Try a sample" — the same list format the
// app is designed for, plus ready-made Claude sentences for it.
import { uid } from '../core/util.js';
import { parseList } from '../core/parse.js';
import { parseReply } from '../core/cloze.js';
import { saveList } from './store.js';

export const SAMPLE_LIST_TEXT = "378.\n\n1. repository (n) /rɪˈpɑːzətɔːri/ : i) nơi lưu trữ đồ đạc số lượng lớn. ii) người nắm được nhiều kiến thức hay thông tin.\n2. interoperability (n) /ˌɪntərˌɑːpərəˈbɪləti/ : khả năng các hệ thống hay thiết bị khác nhau hoạt động cùng nhau.\n3. aggregate (n) /ˈæɡrɪɡət/ : i) kết quả tổng từ các phần nhỏ hơn. ii) cát xây dựng được trộn với xi măng.\n4. acquit (v): i) tuyên chính thức vô tội tại tòa. ii) tự mình thể hiện một màn trình diễn trong công việc như thế nào đó.\n5. understudy (v): học phần lời thoại của diễn viên khác như một phương án dự phòng nếu có vấn đề gì xảy ra với diễn viên đó - chuẩn bị khâu công việc của người khác như một sự dự phòng cho toàn bộ dự án.\n6. jolt (v): làm chuyển động mạnh bạo và bất ngờ. ii) khiến ai sốc và bắt đầu hành động.\n7. fumble (v): i) sử dụng tay một cách vụng về loay hoay khi làm gì. ii) khó khăn trong việc tìm từ ngữ phù hợp.\n8. stale (adj): i) tính cũ, không được tươi mới nữa.\n9. unadorned (adj): tính không hoa lá màu mè - chỉ giản đơn mộc mạc [=plain]\n10. progressive (adj): i) có tính ủng hộ cái mới. ii) có tính xảy ra hay phát triển ổn định. iii) liên quan đến thì tiếp diễn. iv) có tính thuế bị tính cao hơn.\n11. premise (n) /ˈpremɪs/ : tiền đề - cơ sở lập luận\n";

export const SAMPLE_REPLY = "Here are your fill-in sentences — one for each meaning:\n\n```json\n{\"sentences\":[\n{\"w\":1,\"s\":1,\"text\":\"The old warehouse now serves as a [[repository]] for thousands of donated books.\",\"vi\":\"Nhà kho cũ giờ là nơi lưu trữ hàng nghìn cuốn sách được quyên góp.\"},\n{\"w\":1,\"s\":2,\"text\":\"My grandmother is a living [[repository]] of family stories and recipes.\",\"vi\":\"Bà tôi là một kho tàng sống về chuyện gia đình và công thức nấu ăn.\"},\n{\"w\":2,\"s\":1,\"text\":\"Hospitals need better [[interoperability]] so patient records can move smoothly between different software systems.\",\"vi\":\"Các bệnh viện cần khả năng tương tác tốt hơn để hồ sơ bệnh nhân chuyển giữa các hệ thống phần mềm khác nhau một cách suôn sẻ.\"},\n{\"w\":3,\"s\":1,\"text\":\"The team's final score was the [[aggregate]] of points from all three rounds.\",\"vi\":\"Điểm cuối cùng của đội là tổng số điểm của cả ba vòng.\"},\n{\"w\":3,\"s\":2,\"text\":\"The builders mixed cement with coarse [[aggregate]] to make strong concrete for the bridge.\",\"vi\":\"Thợ xây trộn xi măng với cốt liệu thô để làm bê tông chắc chắn cho cây cầu.\"},\n{\"w\":4,\"s\":1,\"text\":\"After a two-week trial, the jury [[acquitted]] him of all charges.\",\"vi\":\"Sau phiên tòa kéo dài hai tuần, bồi thẩm đoàn tuyên anh ta vô tội với mọi cáo buộc.\"},\n{\"w\":4,\"s\":2,\"text\":\"Although it was her first big presentation, she [[acquitted]] herself remarkably well.\",\"vi\":\"Dù là buổi thuyết trình lớn đầu tiên, cô ấy đã thể hiện bản thân rất tốt.\"},\n{\"w\":5,\"s\":1,\"text\":\"While she [[understudied]] the lead role, she learned every line in case the star fell ill.\",\"vi\":\"Khi đóng vai dự bị cho vai chính, cô ấy học thuộc mọi lời thoại phòng khi ngôi sao bị ốm.\"},\n{\"w\":6,\"s\":1,\"text\":\"The bus [[jolted]] to a stop, throwing the passengers forward.\",\"vi\":\"Chiếc xe buýt dừng khựng lại, khiến hành khách bị xô về phía trước.\"},\n{\"w\":6,\"s\":2,\"text\":\"The terrible exam result [[jolted]] him into studying seriously.\",\"vi\":\"Kết quả thi tệ hại đã khiến anh ấy giật mình và bắt đầu học nghiêm túc.\"},\n{\"w\":7,\"s\":1,\"text\":\"He [[fumbled]] with his keys in the dark, unable to find the right one.\",\"vi\":\"Anh ấy loay hoay với chùm chìa khóa trong bóng tối, không tìm được chiếc đúng.\"},\n{\"w\":7,\"s\":2,\"text\":\"Caught off guard by the question, the minister [[fumbled]] for an answer.\",\"vi\":\"Bị bất ngờ trước câu hỏi, vị bộ trưởng lúng túng tìm câu trả lời.\"},\n{\"w\":8,\"s\":1,\"text\":\"Nobody wanted the sandwiches because the bread had gone [[stale]].\",\"vi\":\"Không ai muốn ăn bánh mì kẹp vì bánh mì đã bị cũ.\"},\n{\"w\":9,\"s\":1,\"text\":\"The room was simple and [[unadorned]], with plain white walls and a single wooden chair.\",\"vi\":\"Căn phòng đơn giản, mộc mạc, với tường trắng trơn và một chiếc ghế gỗ.\"},\n{\"w\":10,\"s\":1,\"text\":\"The city is known for its [[progressive]] attitude towards new technology.\",\"vi\":\"Thành phố nổi tiếng với thái độ cởi mở với công nghệ mới.\"},\n{\"w\":10,\"s\":2,\"text\":\"The disease causes a [[progressive]] loss of memory over several years.\",\"vi\":\"Căn bệnh gây suy giảm trí nhớ dần dần trong nhiều năm.\"},\n{\"w\":10,\"s\":3,\"text\":\"In 'She is reading', the verb is in the present [[progressive]] tense.\",\"vi\":\"Trong câu 'She is reading', động từ ở thì hiện tại tiếp diễn.\"},\n{\"w\":10,\"s\":4,\"text\":\"Under a [[progressive]] tax system, people who earn more pay a higher rate.\",\"vi\":\"Theo hệ thống thuế lũy tiến, người có thu nhập cao hơn đóng thuế suất cao hơn.\"},\n{\"w\":11,\"s\":1,\"text\":\"The whole argument rests on the [[premise]] that people always act rationally.\",\"vi\":\"Toàn bộ lập luận dựa trên tiền đề rằng con người luôn hành động lý trí.\"}\n]}\n```\n\nLet me know if you'd like a second set!\n";

export const SAMPLE_FAMILY_TEXT = "1. poorness (noun) /ˈpʊrnəs/: the state or condition of being poor\nExample: The family's poorness became evident when they couldn't afford basic necessities.\n2. impoverish (verb) /ɪmˈpɑvərɪʃ/: to make poor; to reduce to poverty\nExample: The economic crisis threatened to impoverish many working families.\n3. poor (adjective) /pʊr/: having little money or few possessions\nExample: The poor community struggled to access healthcare and education.\n4. poorly (adverb) /ˈpʊrli/: in a poor manner; badly, inadequately\nExample: The students performed poorly on the test due to inadequate preparation.\n\n1. creation (noun): the act of creating\n2. creator (noun): one who creates\n3. creativity (noun): the quality of being creative\n4. create (verb) /kriˈeɪt/: to bring something into existence\n5. creative (adjective): having the ability to create\n";

export const SAMPLE_PASSAGE_TEXT = "The best way to learn a language is to use it every day, even when you make mistakes.\n\nReading the news in English helps you notice how words are used in context,\nand listening to podcasts trains your ear to the rhythm of natural speech.\n";

function listFrom(text, { kind, title, source = '' } = {}) {
  const parsed = parseList(text, kind ? { kind } : {});
  const now = Date.now();
  return {
    id: uid(),
    kind: parsed.kind,
    title: title || parsed.title || 'Sample',
    source,
    rawText: text,
    items: parsed.items,
    sentences: [],
    createdAt: now,
    updatedAt: now,
    lastPracticedAt: null,
  };
}

// Creates the sample vocabulary list (with sentences). Returns the saved list.
export async function createSampleVocabList() {
  const list = listFrom(SAMPLE_LIST_TEXT, { title: 'Sample list', source: 'Vocab Studio sample' });
  list.sentences = parseReply(SAMPLE_REPLY, list).sentences;
  return saveList(list);
}

export async function createSampleFamilyList() {
  return saveList(listFrom(SAMPLE_FAMILY_TEXT, { kind: 'family', title: 'Word families (sample)' }));
}

export async function createSamplePassageList() {
  return saveList(listFrom(SAMPLE_PASSAGE_TEXT, { kind: 'passage', title: 'Dictation (sample)' }));
}
