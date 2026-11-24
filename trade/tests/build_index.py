import sys
app=open('app.html').read(); lg=open('logic.js').read()
assert app.count('/*@@LOGIC@@*/')==1
open('index.html','w').write(app.replace('/*@@LOGIC@@*/', lg))
print('gebaut')
