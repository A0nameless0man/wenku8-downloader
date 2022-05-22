maxrunning=12
pipe=/tmp/ebook-convert-fifo
[ -e $pipe ] || mkfifo $pipe
exec 3<>$pipe
for ((i=1;i<=$maxrunning;i++));do
    echo >&3
done
convert(){
    read -u3
    {
        echo Convert $2 to $3
        ebook-convert "$1" "out/$2.$3" \
        --output-profile tablet\
        --level1-toc //h:h2\
        --level2-toc //h:h3\
        --max-toc-links 0 \
        --formatting-type markdown \
        --title "$2" >/dev/null
        echo Done Convert $2 to $3
        echo >&3
    }&
}
clean(){
    wait
    rm $pipe
    exec 3<&-
    exec 3>&-
}

if ! [ -x "$(command -v ebook-convert)" ];then
    echo "Please install calibre to use this script"
    exit 1
fi
rm -rf "out/*"
mkdir -p "out"
for novel in 2-*/; do
    novel_name=$(echo $novel | sed 's/\/$//')
    out="$novel_name/$novel_name.md"
    rm "$out"
    echo Convert $novel_name to makrdown
    section=1
    sectionc=0
    echo "# $novel_name" >> "$out"
    c=1
    while [ -f "$novel/$c.md" ] ; do
        chapter="$novel/$c.md"
        if [ $sectionc -eq 0 ]; then
            echo "" >> "$out"
            echo "## 第$section卷" >> "$out"
            sectionc=1
            section=$[section+1]
        fi
        title=$(head -n 1 "${chapter}"|sed 's/^# //')
        echo "" >> "$out"
        echo "### $title" >> "$out"
        tail -n +2 "$chapter" >> "$out"
        if [ "$title" = "插图" ];then
            sectionc=0
        fi
        c=$[c+1]
    done
    echo Done Convert $novel_name to makrdown
    convert "$out" "$novel_name" "epub"
    convert "$out" "$novel_name" "mobi"
    convert "$out" "$novel_name" "azw3"
done
clean
echo "done"