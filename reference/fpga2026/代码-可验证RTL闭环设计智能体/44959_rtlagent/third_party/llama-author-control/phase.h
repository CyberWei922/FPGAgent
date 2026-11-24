// Project-authored conservative OUTPUT phase classifier. This is not a probe
// of hidden cognition. Ambiguous/inline-code spans must not receive DRY.
#pragma once
#include <algorithm>
#include <cctype>
#include <deque>
#include <regex>
#include <string>
#include <vector>

namespace rtl_control {
enum class Phase { analysis, draft, code, unknown, submitted };
inline const char * name(Phase p) {
    switch(p) { case Phase::analysis:return "analysis"; case Phase::draft:return "code_draft";
    case Phase::code:return "code_final"; case Phase::submitted:return "submission_boundary";
    default:return "unknown"; }
}
inline std::string trim(std::string s) {
    const auto first=s.find_first_not_of(" \t\r\n");
    return first==std::string::npos?"":s.substr(first,s.find_last_not_of(" \t\r\n")-first+1);
}
inline bool starts_code(const std::string & s) {
    static const std::regex code(R"(^\s*(module\b|endmodule\b|always\b|always_ff\b|always_comb\b|assign\b|wire\b|reg\b|logic\b|localparam\b|parameter\b|input\b|output\b|case\s*\(|if\s*\(|for\s*\(|begin\b|end\b|//|/\*|`|\{|\}))");
    return std::regex_search(s,code);
}
// A candidate extending a possible code delimiter is never DRY-penalized,
// even before the whole delimiter has arrived in separate token pieces.
inline bool protected_piece(const std::string & p) {
    if(p.find_first_of("`~<>;{}[]\\")!=std::string::npos || p.find("//")!=std::string::npos || p.find("/*")!=std::string::npos)return true;
    const auto t=trim(p);
    if(t.empty())return true;
    for(const auto * word:{"module","endmodule","always","assign","wire","reg","logic","localparam","parameter","input","output","begin","end"}) {
        const std::string w(word);
        if(w.rfind(t,0)==0 || t.rfind(w,0)==0)return true;
    }
    return false;
}
struct Tracker {
    Phase phase=Phase::analysis;
    bool thinking=true,answer=false,final_seen=false,fenced=false,raw_draft=false;
    char fence='`'; size_t fence_size=3;
    enum Lex {normal,block,string_lit} lex=normal;
    std::string line,prose_tail;
    std::deque<std::string> prose_lines;
    std::vector<std::string> raw_stack;
    bool raw_invalid=false;
    int repeated_lines=0;
    bool overflow=false;

    void scan_code(const std::string & s,bool track=false) {
        std::string visible;
        for(size_t i=0;i<s.size();++i) {
            char c=s[i],n=i+1<s.size()?s[i+1]:0;
            if(lex==block){if(c=='*'&&n=='/'){lex=normal;++i;}continue;}
            if(lex==string_lit){if(c=='\\'){++i;continue;}if(c=='"')lex=normal;continue;}
            if(c=='/'&&n=='/')break;
            if(c=='/'&&n=='*'){lex=block;++i;continue;}
            if(c=='"'){lex=string_lit;visible+=' ';continue;}
            visible+=c;
        }
        if(track) {
            static const std::regex tokens(R"([A-Za-z_$][A-Za-z0-9_$]*|[(){}\[\]])");
            for(auto i=std::sregex_iterator(visible.begin(),visible.end(),tokens);i!=std::sregex_iterator();++i) {
                const auto t=i->str();std::string close;
                if(t=="module")close="endmodule";else if(t=="begin")close="end";
                else if(t=="case"||t=="casex"||t=="casez")close="endcase";
                else if(t=="function")close="endfunction";else if(t=="task")close="endtask";
                else if(t=="generate")close="endgenerate";
                else if(t=="(")close=")";else if(t=="[")close="]";else if(t=="{")close="}";
                if(!close.empty()){raw_stack.push_back(close);continue;}
                if(t=="endmodule"||t=="end"||t=="endcase"||t=="endfunction"||t=="endtask"||t=="endgenerate"||t==")"||t=="]"||t=="}") {
                    if(raw_stack.empty()||raw_stack.back()!=t)raw_invalid=true;
                    else raw_stack.pop_back();
                }
            }
        }
    }
    bool prose_after_raw(const std::string & s) const {
        // Delayed, fail-closed recovery: the entire first prose line is left
        // unpenalized. Never treat an endmodule alone as a submitted answer.
        static const std::regex sentence(R"(^(But|Now|We|I|The|This|That|Therefore|However|So|Thus|Next|Instead|It|There|Since|Because)\s+[A-Za-z])");
        return !final_seen&&!raw_invalid&&raw_stack.empty()&&lex==normal&&s.size()>=40&&s.back()!=';'&&
            std::count(s.begin(),s.end(),' ')>=6&&std::regex_search(s,sentence);
    }
    void complete_line() {
        const auto s=trim(line);
        if(fenced) {
            const bool close=lex==normal&&s.size()>=fence_size&&s.find_first_not_of(fence)==std::string::npos;
            if(close){fenced=false;phase=answer?Phase::unknown:(thinking&&!final_seen?Phase::analysis:Phase::unknown);}
            else scan_code(line);
        } else if(lex==normal&&s=="<answer>") {
            // A standalone formal boundary also ends an unsubmitted draft.
            answer=true;final_seen=true;raw_draft=false;raw_stack.clear();raw_invalid=false;phase=Phase::code;
        } else if(raw_draft) {
            if(prose_after_raw(s)) {
                raw_draft=false;
                // Mixed prose/code is not accepted as pure analysis. Crucially,
                // its explanatory parentheses must not enter the RTL stack.
                phase=s.find_first_of("`~<>{}[];=()\\\"+*/%&|^!?:")==std::string::npos&&s.back()=='.'?Phase::analysis:Phase::unknown;
            }
            else {scan_code(line,true);phase=Phase::draft;}
        } else if(s=="<think>"||s=="<thinking>") {thinking=true;phase=final_seen?Phase::unknown:Phase::analysis;}
        else if(s=="</think>"||s=="</thinking>"){thinking=false;phase=Phase::unknown;}
        else if(s=="<implementation_notes>"){phase=final_seen?Phase::unknown:Phase::analysis;}
        else if(s=="</implementation_notes>"){phase=Phase::unknown;}
        else if(s=="<answer>"){answer=true;final_seen=true;phase=Phase::code;}
        else if(s=="</answer>"&&answer){answer=false;phase=Phase::submitted;}
        else if(s.rfind("```",0)==0||s.rfind("~~~",0)==0) {
            fence=s[0];fence_size=s.find_first_not_of(fence);if(fence_size==std::string::npos)fence_size=s.size();
            fenced=true;lex=normal;phase=answer?Phase::code:Phase::draft;
        } else if(starts_code(s)) {raw_draft=true;scan_code(line,true);phase=answer?Phase::code:Phase::draft;}
        else if(!s.empty()&&!final_seen) {
            // Explicit analysis contract plus prose-only line, not a semantic guarantee.
            const bool prose=s.find_first_of("`~<>{}[];=")==std::string::npos &&
                std::count(s.begin(),s.end(),' ')>=3;
            phase=prose?Phase::analysis:Phase::unknown;
            if(prose&&s.size()>=40) {
                auto normalized=s;
                std::transform(normalized.begin(),normalized.end(),normalized.begin(),[](unsigned char c){return char(std::tolower(c));});
                repeated_lines=std::count(prose_lines.begin(),prose_lines.end(),normalized);
                prose_lines.push_back(normalized);if(prose_lines.size()>48)prose_lines.pop_front();
                prose_tail+=normalized+'\n';if(prose_tail.size()>8192)prose_tail.erase(0,prose_tail.size()-8192);
            }
        }
        line.clear();
    }
    void push(const std::string & piece) {
        if(overflow)return;
        if(piece.find('\n')==std::string::npos&&line.size()+piece.size()>32768){overflow=true;phase=Phase::unknown;return;}
        for(char c:piece) {
            line+=c;
            if(line.size()>32768){overflow=true;phase=Phase::unknown;return;}
            if(c=='\n'){complete_line();continue;}
            if(fenced||raw_draft||phase==Phase::submitted)continue;
            const auto s=trim(line);
            if(s=="</think>"||s=="</thinking>"){thinking=false;phase=Phase::unknown;}
            if(s=="<answer>"){answer=true;final_seen=true;phase=Phase::code;}
            if(s=="</answer>"&&answer){answer=false;phase=Phase::submitted;}
            if(starts_code(s))phase=answer?Phase::code:Phase::draft;
            else if(!final_seen&&s.find_first_of("`~<>{}[];=")!=std::string::npos)phase=Phase::unknown;
        }
    }
    bool safe_prose_boundary() const {
        if(phase!=Phase::analysis||overflow||final_seen||fenced||raw_draft)return false;
        return line.empty() || (!line.empty()&&(line.back()=='.'||line.back()=='\n'));
    }
    bool safe_submission_restart() const {
        // Budget escape, NOT analysis classification or DRY permission. An
        // unsubmitted raw/pseudo draft can stay protected indefinitely. Only
        // a complete lexical line outside fences/comments/strings may be
        // abandoned, and never after the formal answer has begun.
        return !overflow&&!final_seen&&!answer&&!fenced&&lex==normal&&line.empty()&&
            (raw_draft||phase==Phase::unknown);
    }
    void abandon_unsubmitted_draft() {
        const bool was_thinking=thinking;
        *this=Tracker{};thinking=was_thinking;phase=Phase::unknown;
    }
    bool repetitive() const {
        if(repeated_lines>=2)return true;
        if(prose_tail.size()<384)return false;
        const auto suffix=prose_tail.substr(prose_tail.size()-128);
        const auto first=prose_tail.find(suffix);
        return first<prose_tail.size()-256 && prose_tail.find(suffix,first+128)<prose_tail.size()-128;
    }
};
}
