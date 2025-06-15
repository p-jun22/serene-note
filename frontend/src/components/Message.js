import React from 'react';

const Message = ({ sender, text }) => {
  return (
    <div className={`message ${sender}`}>
      <pre>{text}</pre>
    </div>
  );
};

export default Message;
