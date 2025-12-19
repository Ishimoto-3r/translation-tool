module.exports = async (req,res)=>{
  if(req.method!=='POST') return res.status(405).end();
  const {prompt,model,verbosity,images=[]}=req.body;
  const content=[];
  if(prompt) content.push({type:'input_text',text:prompt});
  images.forEach(u=>content.push({type:'input_image',image_url:u}));

  const body={
    model: model||'gpt-5.1',
    input:[{role:'user',content}],
    text:{verbosity:verbosity||'low'},
    stream:true
  };

  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{
      'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });

  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
  const reader=r.body.getReader(),dec=new TextDecoder();
  let buf='',data='';
  const flush=()=>{
    try{
      const o=JSON.parse(data);
      if(o.type==='response.output_text.delta') res.write(o.delta);
    }catch{}
    data='';
  };
  while(true){
    const {value,done}=await reader.read();
    if(done)break;
    buf+=dec.decode(value,{stream:true});
    let i;
    while((i=buf.indexOf('\n'))>-1){
      const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);
      if(!line){ flush(); continue; }
      if(line.startsWith('data:')) data+=line.slice(5);
    }
  }
  flush(); res.end();
};
